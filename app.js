/**
 * Generic B2B Directory Scraper — Express app (no listen() here, so it can
 * be imported directly by tests via supertest without binding a real port).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import * as cheerio from "cheerio";

import { collectLinks, abs } from "./lib/collectLinks.js";
import { requireAuth, login, logout } from "./lib/auth.js";
import { fetchPage } from "./lib/httpFetch.js";
import { createClient } from "./lib/anthropicClient.js";
import {
  getOutputFile,
  validateConfig,
  readConfig,
  writeConfig,
  ensureDataDir,
} from "./lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── In-flight guard ────────────────────────────────────────────────────────────
// /api/detect and /api/scrape both read/write the same config/output files, so
// only one may run at a time.
let busy = false;

function truncate(str, max = 5000) {
  const bodyMatch = str.match(/<body[\s\S]*<\/body>/i);
  const content = bodyMatch ? bodyMatch[0] : str;
  return content.length > max ? content.slice(0, max) + "\n...[truncated]" : content;
}

// ── SSE helper ────────────────────────────────────────────────────────────────
function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}
function sseSend(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "public")));

  app.post("/api/login", login);
  app.post("/api/logout", logout);

  // Everything below requires a valid session.
  app.use("/api", requireAuth);

  // ── GET config ────────────────────────────────────────────────────────────
  app.get("/api/config", (req, res) => {
    res.json(readConfig());
  });

  // ── SAVE config ───────────────────────────────────────────────────────────
  app.post("/api/config", (req, res) => {
    const missing = validateConfig(req.body);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required selector(s): ${missing.join(", ")}` });
    }
    writeConfig(req.body);
    res.json({ ok: true });
  });

  // ── DETECT ────────────────────────────────────────────────────────────────
  app.get("/api/detect", async (req, res) => {
    const startUrl = req.query.url;
    if (!startUrl) return res.status(400).json({ error: "url required" });

    if (busy) return res.status(409).json({ error: "Another detect/scrape is already running" });
    busy = true;

    sseSetup(res);
    try {
      sseSend(res, "log", { msg: `Fetching homepage: ${startUrl}` });

      const homeHtml = await fetchPage(startUrl);
      if (!homeHtml) { sseSend(res, "error", { msg: "Could not fetch URL" }); return res.end(); }

      const origin = new URL(startUrl).origin;
      const $home = cheerio.load(homeHtml);
      const candidateLinks = collectLinks(
        $home, startUrl, "a[href]",
        (full) => full !== startUrl && full.startsWith(origin)
      );

      let categoryPageHtml = null, categoryPageUrl = null;
      for (const link of candidateLinks.slice(0, 5)) {
        await sleep(DELAY_MS);
        sseSend(res, "log", { msg: `Trying category page: ${link}` });
        const html = await fetchPage(link);
        if (html && html.length > 2000) { categoryPageHtml = html; categoryPageUrl = link; break; }
      }

      let companyPageHtml = null, companyPageUrl = null;
      if (categoryPageHtml) {
        const $cat = cheerio.load(categoryPageHtml);
        const compCandidates = collectLinks(
          $cat, categoryPageUrl, "a[href]",
          (full) => full !== categoryPageUrl
        );
        for (const link of compCandidates.slice(0, 5)) {
          await sleep(DELAY_MS);
          sseSend(res, "log", { msg: `Trying company page: ${link}` });
          const html = await fetchPage(link);
          if (html && html.length > 2000) { companyPageHtml = html; companyPageUrl = link; break; }
        }
      }

      sseSend(res, "log", { msg: "Asking Claude to analyse site structure..." });

      const prompt = `You are analysing a B2B directory website. Return ONLY valid JSON, no markdown fences:
{
  "start_url": "${startUrl}",
  "category_links": "CSS selector",
  "company_links": "CSS selector",
  "website_url": "CSS selector",
  "next_page": "CSS selector or null",
  "notes": "brief notes"
}

PAGE 1 (homepage ${startUrl}):
${truncate(homeHtml, 4000)}

${categoryPageHtml ? `PAGE 2 (category ${categoryPageUrl}):\n${truncate(categoryPageHtml, 4000)}` : "PAGE 2: unavailable"}

${companyPageHtml ? `PAGE 3 (company ${companyPageUrl}):\n${truncate(companyPageHtml, 3000)}` : "PAGE 3: unavailable"}`;

      const client = createClient();
      const message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = message.content[0].text.trim()
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

      try {
        const config = JSON.parse(raw);
        writeConfig(config);
        sseSend(res, "config", { config });
        sseSend(res, "done", { msg: "Detection complete" });
      } catch {
        sseSend(res, "error", { msg: "Claude returned invalid JSON", raw });
      }
    } catch (err) {
      sseSend(res, "error", { msg: `Detect failed: ${err.message}` });
    } finally {
      busy = false;
      res.end();
    }
  });

  // ── SCRAPE ────────────────────────────────────────────────────────────────
  app.get("/api/scrape", async (req, res) => {
    const config = readConfig();
    if (!config) return res.status(400).json({ error: "No config found. Run detect first." });

    if (busy) return res.status(409).json({ error: "Another detect/scrape is already running" });
    busy = true;

    sseSetup(res);
    ensureDataDir();
    const out = fs.createWriteStream(getOutputFile(), { flags: "w" });
    let total = 0;

    try {
      sseSend(res, "log", { msg: `Discovering categories from ${config.start_url}...` });
      await sleep(DELAY_MS);
      const homeHtml = await fetchPage(config.start_url);
      if (!homeHtml) { sseSend(res, "error", { msg: "Could not fetch start URL" }); return res.end(); }

      const $home = cheerio.load(homeHtml);
      const catList = collectLinks(
        $home, config.start_url, config.category_links,
        (full) => full !== config.start_url
      );

      sseSend(res, "log", { msg: `Found ${catList.length} categories` });
      if (catList.length === 0) {
        sseSend(res, "log", { msg: "WARNING: 0 categories matched category_links selector — check your config", cls: "err" });
      }

      for (let ci = 0; ci < catList.length; ci++) {
        const catUrl = catList[ci];
        sseSend(res, "category", { msg: `[${ci + 1}/${catList.length}] ${catUrl}`, index: ci + 1, total: catList.length });

        let currentUrl = catUrl, page = 1;
        while (currentUrl) {
          await sleep(DELAY_MS);
          sseSend(res, "log", { msg: `  Page ${page}: ${currentUrl}` });
          const html = await fetchPage(currentUrl);
          if (!html) break;

          const $cat = cheerio.load(html);
          const compLinks = collectLinks($cat, currentUrl, config.company_links);

          if (compLinks.length === 0 && page === 1) {
            sseSend(res, "log", { msg: `  WARNING: 0 companies matched company_links selector on ${currentUrl}`, cls: "err" });
          }
          if (compLinks.length === 0 && page > 1) break;

          for (const compUrl of compLinks) {
            await sleep(DELAY_MS);
            const compHtml = await fetchPage(compUrl);
            if (!compHtml) continue;

            const $c = cheerio.load(compHtml);
            const el = $c(config.website_url).first();
            let websiteUrl = el.attr("href") || el.text().trim();
            if (websiteUrl) {
              websiteUrl = websiteUrl.trim();
              if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = "https://" + websiteUrl;
              if (!websiteUrl.includes(new URL(config.start_url).hostname)) {
                out.write(websiteUrl + "\n");
                total++;
                sseSend(res, "url", { url: websiteUrl, total });
              }
            }
          }

          if (config.next_page) {
            const nextHref = $cat(config.next_page).attr("href");
            const nextFull = abs(nextHref, currentUrl);
            currentUrl = nextFull && nextFull !== currentUrl ? nextFull : null;
          } else {
            currentUrl = null;
          }
          page++;
        }
      }

      sseSend(res, "done", { msg: `Scrape complete. ${total} URLs saved.`, total });
    } catch (err) {
      sseSend(res, "error", { msg: `Scrape failed: ${err.message}` });
    } finally {
      out.end();
      busy = false;
      res.end();
    }
  });

  // ── DOWNLOAD ──────────────────────────────────────────────────────────────
  app.get("/api/download", (req, res) => {
    const outputFile = getOutputFile();
    if (!fs.existsSync(outputFile)) return res.status(404).send("No output file yet");
    res.download(outputFile, "leads.txt");
  });

  return app;
}
