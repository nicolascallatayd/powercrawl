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
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const FALLBACK_ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-opus-4-6",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isModelNotFoundError(err) {
  if (!err) return false;
  if (err.status === 404 || err.statusCode === 404) return true;
  if (err.type === "not_found_error" || err.error?.type === "not_found_error")
    return true;
  const message = typeof err.message === "string" ? err.message : "";
  return (
    /model/i.test(message) ||
    /not_found_error/i.test(message) ||
    /404/i.test(message)
  );
}

async function createAnthropicMessage(client, prompt, onFallback) {
  const preferredModel = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const models = [preferredModel, ...FALLBACK_ANTHROPIC_MODELS].filter(Boolean);
  const uniqueModels = models.filter(
    (model, index) => models.indexOf(model) === index,
  );

  let lastError;
  for (const model of uniqueModels) {
    try {
      return await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      lastError = err;
      const isModelNotFound = isModelNotFoundError(err);
      const nextModel = uniqueModels[uniqueModels.indexOf(model) + 1];
      if (!isModelNotFound || !nextModel) {
        throw err;
      }
      if (onFallback) {
        onFallback(model, nextModel);
      }
    }
  }

  throw lastError;
}

// ── In-flight guard ────────────────────────────────────────────────────────────
let busy = false;

function truncate(str, max = 5000) {
  const bodyMatch = str.match(/<body[\s\S]*<\/body>/i);
  const content = bodyMatch ? bodyMatch[0] : str;
  return content.length > max
    ? content.slice(0, max) + "\n...[truncated]"
    : content;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}
function sseSend(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function buildHeuristicConfig(startUrl) {
  return {
    start_url: startUrl,
    category_links: "a[href]",
    company_links: "a[href]",
    website_url: "a[href]",
    next_page: null,
    extraction_mode: "profile",
    notes: "heuristic fallback because Anthropic model detection failed",
  };
}

// ── FIX 1: Smarter candidate page discovery ───────────────────────────────────
// Instead of blindly taking the first 5 internal links (which are usually nav
// links like /about, /contact), score each link by how much it looks like a
// category listing URL and pick the best candidates.
function scoreLinkAsCategory(href) {
  let score = 0;
  // Path segments that strongly suggest a category listing
  if (/categor|industry|sector|product|listing|index|search|browse/i.test(href))
    score += 3;
  // Has a numeric ID in the path — common in B2B directories
  if (/\/\d+/.test(href)) score += 2;
  // Has a slug-like segment
  if (/-[a-z]/.test(href)) score += 1;
  // Penalise obvious non-listing pages
  if (
    /about|contact|login|signup|register|advertis|privacy|terms|faq|help|blog|news|sitemap/i.test(
      href,
    )
  )
    score -= 5;
  // Penalise file extensions that aren't HTML
  if (/\.(pdf|jpg|png|gif|css|js|xml|zip)$/i.test(href)) score -= 5;
  return score;
}

function pickCategoryPageCandidates(links, startUrl, n = 10) {
  const origin = new URL(startUrl).origin;
  return links
    .filter((l) => l.startsWith(origin) && l !== startUrl)
    .map((l) => ({ url: l, score: scoreLinkAsCategory(l) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.url);
}

// ── FIX 2: Inline website URL extraction ─────────────────────────────────────
// Many B2B directories (e.g. yellowpages.com.vn) show the company website URL
// directly on the listing page, not on the individual company profile.
// extraction_mode: "inline" → grab URLs from the listing page itself.
// extraction_mode: "profile" (default) → visit each company profile page.
function extractInlineWebsiteUrls(html, listingPageUrl, config) {
  const $ = cheerio.load(html);
  const directoryHostname = new URL(config.start_url).hostname;
  const seen = new Set();
  const urls = [];

  // Use website_url selector if it's specific enough (not just "a[href]")
  const selector =
    config.website_url && config.website_url !== "a[href]"
      ? config.website_url
      : "a[href]";

  $(selector).each((_, el) => {
    let href = $(el).attr("href") || "";
    href = href.trim();
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    if (!/^https?:\/\//i.test(href)) {
      // Try to resolve relative — but skip if it resolves to the same domain
      try {
        href = new URL(href, listingPageUrl).href;
      } catch {
        return;
      }
    }
    try {
      const h = new URL(href).hostname.replace(/^www\./, "");
      const dir = directoryHostname.replace(/^www\./, "");
      // Must be an external domain
      if (h === dir || h.endsWith("." + dir)) return;
    } catch {
      return;
    }
    // Skip images, docs, sister-site banners, social platforms
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js)$/i.test(href)) return;
    if (
      /facebook\.com|twitter\.com|linkedin\.com|instagram\.com|youtube\.com/i.test(
        href,
      )
    )
      return;
    if (!seen.has(href)) {
      seen.add(href);
      urls.push(href);
    }
  });

  return urls;
}

// ── FIX 3: Robust next-page detection ────────────────────────────────────────
// Handles: rel=next, ?page=N, /page/N, explicit next-link selector.
function findNextPage($, currentUrl, nextPageSelector) {
  // 1. Explicit CSS selector from config
  if (nextPageSelector) {
    const href = $(nextPageSelector).attr("href");
    if (href) {
      const full = abs(href, currentUrl);
      if (full && full !== currentUrl) return full;
    }
  }

  // 2. <link rel="next">
  const relNext = $('link[rel="next"]').attr("href");
  if (relNext) {
    const full = abs(relNext, currentUrl);
    if (full && full !== currentUrl) return full;
  }

  // 3. <a rel="next"> or aria-label="Next"
  const anchorNext =
    $('a[rel="next"]').attr("href") ||
    $('a[aria-label="Next"]').attr("href") ||
    $('a[aria-label="next"]').attr("href");
  if (anchorNext) {
    const full = abs(anchorNext, currentUrl);
    if (full && full !== currentUrl) return full;
  }

  // 4. Anchor whose text is exactly "Next" / "›" / "»"
  let nextFromText = null;
  $("a").each((_, el) => {
    const text = $(el).text().trim();
    if (/^(next|›|»|>)$/i.test(text)) {
      const href = $(el).attr("href");
      if (href) {
        const full = abs(href, currentUrl);
        if (full && full !== currentUrl) {
          nextFromText = full;
          return false;
        }
      }
    }
  });
  if (nextFromText) return nextFromText;

  // 5. ?page=N increment
  try {
    const u = new URL(currentUrl);
    const currentPage = parseInt(u.searchParams.get("page") || "1", 10);
    const nextPage = currentPage + 1;
    // Only follow if there's a link on the page pointing to page N+1
    let found = null;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      try {
        const candidate = new URL(href, currentUrl);
        if (
          parseInt(candidate.searchParams.get("page") || "0", 10) === nextPage
        ) {
          found = candidate.href;
          return false;
        }
      } catch {
        /* skip */
      }
    });
    if (found) return found;
  } catch {
    /* not a valid URL */
  }

  return null;
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
      return res
        .status(400)
        .json({ error: `Missing required selector(s): ${missing.join(", ")}` });
    }
    writeConfig(req.body);
    res.json({ ok: true });
  });

  // ── DETECT ────────────────────────────────────────────────────────────────
  app.get("/api/detect", async (req, res) => {
    const startUrl = req.query.url;
    if (!startUrl) return res.status(400).json({ error: "url required" });

    if (busy)
      return res
        .status(409)
        .json({ error: "Another detect/scrape is already running" });
    busy = true;

    sseSetup(res);
    try {
      sseSend(res, "log", { msg: `Fetching homepage: ${startUrl}` });

      const homeHtml = await fetchPage(startUrl);
      if (!homeHtml) {
        sseSend(res, "error", { msg: "Could not fetch URL" });
        return res.end();
      }

      // FIX 1: Use scored candidate selection instead of first-5-links
      const $home = cheerio.load(homeHtml);
      const allLinks = collectLinks($home, startUrl, "a[href]", () => true);
      const candidateLinks = pickCategoryPageCandidates(allLinks, startUrl, 10);

      let categoryPageHtml = null,
        categoryPageUrl = null;
      for (const link of candidateLinks) {
        await sleep(DELAY_MS);
        sseSend(res, "log", { msg: `Trying category page: ${link}` });
        const html = await fetchPage(link);
        if (html && html.length > 2000) {
          // Make sure this page actually has multiple links (looks like a listing)
          const $tmp = cheerio.load(html);
          const linkCount = $tmp("a[href]").length;
          if (linkCount >= 5) {
            categoryPageHtml = html;
            categoryPageUrl = link;
            break;
          }
        }
      }

      // Try to find a company profile page from the listing page
      let companyPageHtml = null,
        companyPageUrl = null;
      if (categoryPageHtml) {
        const $cat = cheerio.load(categoryPageHtml);
        // Score candidates differently: company profiles often have longer paths / IDs
        const compCandidates = collectLinks(
          $cat,
          categoryPageUrl,
          "a[href]",
          (full) => {
            if (full === categoryPageUrl) return false;
            try {
              const u = new URL(full);
              // Prefer links with numeric IDs or deeper paths
              return u.pathname.split("/").length >= 3;
            } catch {
              return false;
            }
          },
        );
        for (const link of compCandidates.slice(0, 8)) {
          await sleep(DELAY_MS);
          sseSend(res, "log", { msg: `Trying company page: ${link}` });
          const html = await fetchPage(link);
          if (html && html.length > 2000) {
            companyPageHtml = html;
            companyPageUrl = link;
            break;
          }
        }
      }

      sseSend(res, "log", {
        msg: "Asking Claude to analyse site structure...",
      });

      // FIX 2: Enhanced prompt — tells Claude about extraction_mode
      const prompt = `You are analysing a B2B business directory website to extract CSS selectors for automated scraping.

Return ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:
{
  "start_url": "${startUrl}",
  "category_links": "CSS selector for links to category/subcategory listing pages",
  "company_links": "CSS selector for links to individual company profile pages within a listing page",
  "website_url": "CSS selector for the company external website URL (on the listing page OR on the company profile page)",
  "next_page": "CSS selector for the next-page pagination link, or null if none",
  "extraction_mode": "inline OR profile",
  "notes": "brief notes on the site structure"
}

CRITICAL — extraction_mode:
- Use "inline" if company website URLs are visible directly on the category listing page (no need to visit each company profile).
- Use "profile" if you must visit each company's individual profile page to find their website URL.
- When in doubt, look at PAGE 2. If you can see external website URLs (e.g. www.somecompany.com) as clickable links on the listing page itself, use "inline".

For category_links: pick the selector that matches links to category/subcategory pages, NOT to company profiles.
For company_links: pick the selector that matches links to individual company detail pages.
For website_url: pick the selector that matches the company's own external website anchor tag.
For next_page: look for a "Next" link, rel=next, or ?page=N / /page/N style link. Return null if there is no pagination.

PAGE 1 — Homepage (${startUrl}):
${truncate(homeHtml, 4000)}

${categoryPageHtml ? `PAGE 2 — Category/listing page (${categoryPageUrl}):\n${truncate(categoryPageHtml, 4000)}` : "PAGE 2 — unavailable"}

${companyPageHtml ? `PAGE 3 — Company profile page (${companyPageUrl}):\n${truncate(companyPageHtml, 3000)}` : "PAGE 3 — unavailable"}`;

      let config;
      try {
        const client = createClient();
        const message = await createAnthropicMessage(
          client,
          prompt,
          (attemptedModel, fallbackModel) => {
            sseSend(res, "log", {
              msg: `Anthropic model ${attemptedModel} unavailable; retrying with ${fallbackModel}`,
            });
          },
        );

        const raw = message.content[0].text
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();

        config = JSON.parse(raw);
        // Default extraction_mode if Claude omitted it
        if (!config.extraction_mode) config.extraction_mode = "profile";
      } catch (err) {
        config = buildHeuristicConfig(startUrl);
        sseSend(res, "log", {
          msg: `Anthropic analysis unavailable; using heuristic fallback: ${err.message}`,
        });
      }

      writeConfig(config);
      sseSend(res, "config", { config });
      sseSend(res, "done", { msg: "Detection complete" });
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
    if (!config)
      return res
        .status(400)
        .json({ error: "No config found. Run detect first." });

    if (busy)
      return res
        .status(409)
        .json({ error: "Another detect/scrape is already running" });
    busy = true;

    sseSetup(res);
    ensureDataDir();
    const out = fs.createWriteStream(getOutputFile(), { flags: "w" });
    let total = 0;

    // FIX 2: Respect extraction_mode
    const isInline = config.extraction_mode === "inline";
    const directoryHostname = new URL(config.start_url).hostname;

    try {
      sseSend(res, "log", {
        msg: `Discovering categories from ${config.start_url}...`,
      });
      sseSend(res, "log", {
        msg: `Extraction mode: ${isInline ? "inline (URLs on listing page)" : "profile (visit each company page)"}`,
      });

      await sleep(DELAY_MS);
      const homeHtml = await fetchPage(config.start_url);
      if (!homeHtml) {
        sseSend(res, "error", { msg: "Could not fetch start URL" });
        return res.end();
      }

      const $home = cheerio.load(homeHtml);
      const catList = collectLinks(
        $home,
        config.start_url,
        config.category_links,
        (full) => full !== config.start_url,
      );

      sseSend(res, "log", { msg: `Found ${catList.length} categories` });
      if (catList.length === 0) {
        sseSend(res, "log", {
          msg: "WARNING: 0 categories matched — check your category_links selector",
          cls: "err",
        });
      }

      for (let ci = 0; ci < catList.length; ci++) {
        const catUrl = catList[ci];
        sseSend(res, "category", {
          msg: `[${ci + 1}/${catList.length}] ${catUrl}`,
          index: ci + 1,
          total: catList.length,
        });

        let currentUrl = catUrl,
          page = 1;
        while (currentUrl) {
          await sleep(DELAY_MS);
          sseSend(res, "log", { msg: `  Page ${page}: ${currentUrl}` });
          const html = await fetchPage(currentUrl);
          if (!html) break;

          const $cat = cheerio.load(html);

          if (isInline) {
            // FIX 2: Extract website URLs directly from the listing page
            const urls = extractInlineWebsiteUrls(html, currentUrl, config);
            if (urls.length === 0 && page === 1) {
              sseSend(res, "log", {
                msg: `  WARNING: 0 inline URLs found on ${currentUrl} — consider switching to extraction_mode: profile`,
                cls: "err",
              });
            }
            for (const url of urls) {
              out.write(url + "\n");
              total++;
              sseSend(res, "url", { url, total });
            }
          } else {
            // Profile mode: visit each company page
            const compLinks = collectLinks(
              $cat,
              currentUrl,
              config.company_links,
            );

            if (compLinks.length === 0 && page === 1) {
              sseSend(res, "log", {
                msg: `  WARNING: 0 companies matched company_links on ${currentUrl}`,
                cls: "err",
              });
            }
            if (compLinks.length === 0 && page > 1) break;

            for (const compUrl of compLinks) {
              // Skip links that point back to the directory itself
              try {
                const h = new URL(compUrl).hostname.replace(/^www\./, "");
                const dir = directoryHostname.replace(/^www\./, "");
                if (h !== dir && !h.endsWith("." + dir)) {
                  // This is already an external URL — treat it as the website URL directly
                  out.write(compUrl + "\n");
                  total++;
                  sseSend(res, "url", { url: compUrl, total });
                  continue;
                }
              } catch {
                continue;
              }

              await sleep(DELAY_MS);
              const compHtml = await fetchPage(compUrl);
              if (!compHtml) continue;

              const $c = cheerio.load(compHtml);
              const el = $c(config.website_url).first();
              let websiteUrl = el.attr("href") || el.text().trim();
              if (websiteUrl) {
                websiteUrl = websiteUrl.trim();
                if (!/^https?:\/\//i.test(websiteUrl))
                  websiteUrl = "https://" + websiteUrl;
                try {
                  const h = new URL(websiteUrl).hostname.replace(/^www\./, "");
                  const dir = directoryHostname.replace(/^www\./, "");
                  if (h !== dir && !h.endsWith("." + dir)) {
                    out.write(websiteUrl + "\n");
                    total++;
                    sseSend(res, "url", { url: websiteUrl, total });
                  }
                } catch {
                  /* invalid URL, skip */
                }
              }
            }
          }

          // FIX 3: Robust next-page detection
          const nextUrl = findNextPage($cat, currentUrl, config.next_page);
          currentUrl = nextUrl || null;
          page++;
        }
      }

      sseSend(res, "done", {
        msg: `Scrape complete. ${total} URLs saved.`,
        total,
      });
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
    if (!fs.existsSync(outputFile))
      return res.status(404).send("No output file yet");
    res.download(outputFile, "leads.txt");
  });

  return app;
}
