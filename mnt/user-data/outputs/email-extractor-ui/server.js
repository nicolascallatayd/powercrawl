/**
 * Email Extractor — Server
 *
 * npm install node-fetch cheerio express
 * node server.js
 * Then open http://localhost:3002
 */

const fs      = require("fs");
const path    = require("path");
const express = require("express");
const app     = express();

let fetch, cheerio;
try {
  fetch   = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
  cheerio = require("cheerio");
} catch {
  console.error("Run:  npm install node-fetch cheerio express");
  process.exit(1);
}

app.use(express.json());
app.use(express.static(__dirname));

const OUTPUT_FILE = path.join(__dirname, "emails.txt");
const DELAY_MS    = 3000;
const TIMEOUT_MS  = 12000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const EMAIL_RE       = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK_RE        = /\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|css|js)$/i;
const CONTACT_PATS   = [/contact/i, /kontakt/i, /reach/i, /get.in.touch/i];
const ABOUT_PATS     = [/about/i, /o.nas/i, /who.we.are/i, /company/i, /firma/i];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}
function sseSend(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return null;
    return await res.text();
  } catch { return null; }
}

function abs(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

function extractEmails(text) {
  return (text.match(EMAIL_RE) || []).filter(e => !JUNK_RE.test(e));
}

function findSubpages(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl).origin;
  let contact = null, about = null;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let full; try { full = new URL(href, baseUrl).href; } catch { return; }
    if (!full.startsWith(base)) return;
    const text = ($(el).text() + " " + href).toLowerCase();
    if (!contact && CONTACT_PATS.some(p => p.test(text))) contact = full;
    if (!about   && ABOUT_PATS.some(p => p.test(text)))   about   = full;
  });
  return { contact, about };
}

async function scrapeWebsite(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "https://" + rawUrl;
  const emails = new Set();
  const visited = new Set();

  await sleep(DELAY_MS);
  const homeHtml = await fetchPage(url);
  if (!homeHtml) return [];
  visited.add(url);
  extractEmails(homeHtml).forEach(e => emails.add(e));

  const { contact, about } = findSubpages(homeHtml, url);

  if (contact && !visited.has(contact)) {
    await sleep(DELAY_MS);
    const html = await fetchPage(contact);
    visited.add(contact);
    if (html) extractEmails(html).forEach(e => emails.add(e));
  }

  if (about && !visited.has(about)) {
    await sleep(DELAY_MS);
    const html = await fetchPage(about);
    visited.add(about);
    if (html) extractEmails(html).forEach(e => emails.add(e));
  }

  return [...emails];
}

// ── EXTRACT endpoint ──────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "urls array required" });
  }

  sseSetup(res);
  const out = fs.createWriteStream(OUTPUT_FILE, { flags: "w" });
  let totalEmails = 0;
  let sitesWithEmails = 0;

  sseSend(res, "start", { total: urls.length });

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;
    sseSend(res, "site", { url, index: i + 1, total: urls.length });

    const emails = await scrapeWebsite(url);

    if (emails.length > 0) {
      sitesWithEmails++;
      totalEmails += emails.length;
      emails.forEach(e => out.write(e + "\n"));
      sseSend(res, "emails", { url, emails, index: i + 1 });
    } else {
      sseSend(res, "noemails", { url, index: i + 1 });
    }
  }

  out.end();
  sseSend(res, "done", { totalEmails, sitesWithEmails, totalSites: urls.length });
  res.end();
});

app.get("/api/download", (req, res) => {
  if (!fs.existsSync(OUTPUT_FILE)) return res.status(404).send("No output yet");
  res.download(OUTPUT_FILE, "emails.txt");
});

app.listen(3002, () => console.log("Email Extractor UI → http://localhost:3002"));
