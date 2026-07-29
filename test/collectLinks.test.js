import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { collectLinks, abs } from "../lib/collectLinks.js";

describe("abs", () => {
  it("resolves a relative href against a base URL", () => {
    expect(abs("/foo", "https://example.com/bar")).toBe("https://example.com/foo");
  });

  it("returns null for a missing href", () => {
    expect(abs(null, "https://example.com")).toBeNull();
    expect(abs(undefined, "https://example.com")).toBeNull();
  });

  it("returns null for a malformed href/base combination", () => {
    expect(abs("::not a url::", "not-a-base")).toBeNull();
  });
});

describe("collectLinks", () => {
  it("collects and dedupes matching links, preserving document order", () => {
    const html = `
      <a href="/a">A</a>
      <a href="/b">B</a>
      <a href="/a">A again</a>
    `;
    const $ = cheerio.load(html);
    const links = collectLinks($, "https://example.com", "a[href]");
    expect(links).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("returns an empty array for an empty/undefined selector", () => {
    const $ = cheerio.load(`<a href="/a">A</a>`);
    expect(collectLinks($, "https://example.com", "")).toEqual([]);
    expect(collectLinks($, "https://example.com", undefined)).toEqual([]);
  });

  it("returns an empty array when the selector matches nothing", () => {
    const $ = cheerio.load(`<a href="/a">A</a>`);
    expect(collectLinks($, "https://example.com", ".no-match")).toEqual([]);
  });

  it("applies the filter function to exclude links", () => {
    const html = `<a href="/keep">Keep</a><a href="/drop">Drop</a>`;
    const $ = cheerio.load(html);
    const links = collectLinks($, "https://example.com", "a[href]", (full) => !full.endsWith("/drop"));
    expect(links).toEqual(["https://example.com/keep"]);
  });

  it("skips anchors with malformed hrefs", () => {
    const $ = cheerio.load(`<a href="::bad::">Bad</a><a href="/ok">Ok</a>`);
    const links = collectLinks($, "not a valid base at all", "a[href]");
    expect(links).toEqual([]);
  });
});
