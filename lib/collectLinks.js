/**
 * Load an HTML page with cheerio and collect absolute links matching a selector.
 *
 * @param {import('cheerio').CheerioAPI} $ - cheerio-loaded document
 * @param {string} baseUrl - base URL to resolve relative hrefs against
 * @param {string} selector - CSS selector for the anchor elements to collect
 * @param {(full: string, el: any) => boolean} [filterFn] - optional predicate;
 *   receives the resolved absolute URL and the raw cheerio element, return
 *   false to exclude it. Defaults to "always include".
 * @returns {string[]} deduped list of absolute URLs, in document order
 */
export function abs(href, base) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

export function collectLinks($, baseUrl, selector, filterFn = () => true) {
  const seen = new Set();
  const out = [];
  if (!selector) return out;

  $(selector).each((_, el) => {
    const href = $(el).attr("href");
    const full = abs(href, baseUrl);
    if (!full) return;
    if (!filterFn(full, el)) return;
    if (seen.has(full)) return;
    seen.add(full);
    out.push(full);
  });

  return out;
}
