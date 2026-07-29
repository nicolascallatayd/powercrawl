import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { validateConfig, readConfig, writeConfig, getConfigFile } from "../lib/config.js";

describe("validateConfig", () => {
  it("returns all required fields missing for null/undefined config", () => {
    expect(validateConfig(null)).toEqual(["category_links", "company_links", "website_url"]);
    expect(validateConfig(undefined)).toEqual(["category_links", "company_links", "website_url"]);
  });

  it("returns an empty array when all required fields are present", () => {
    expect(validateConfig({
      category_links: "a.cat", company_links: "a.company", website_url: "a.site",
    })).toEqual([]);
  });

  it("flags blank/whitespace-only fields as missing", () => {
    expect(validateConfig({
      category_links: "a.cat", company_links: "  ", website_url: "a.site",
    })).toEqual(["company_links"]);
  });

  it("does not require next_page or notes", () => {
    expect(validateConfig({
      category_links: "a.cat", company_links: "a.company", website_url: "a.site",
      next_page: null, notes: "",
    })).toEqual([]);
  });
});

describe("readConfig / writeConfig", () => {
  let tmpDataDir;
  const ORIGINAL_DATA_DIR = process.env.POWERCRAWL_DATA_DIR;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "powercrawl-test-"));
    process.env.POWERCRAWL_DATA_DIR = tmpDataDir;
  });

  afterEach(() => {
    process.env.POWERCRAWL_DATA_DIR = ORIGINAL_DATA_DIR;
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists yet", () => {
    expect(readConfig()).toBeNull();
  });

  it("round-trips a config object through the real config file path", () => {
    const cfg = { category_links: "a.cat", company_links: "a.co", website_url: "a.site" };
    writeConfig(cfg);
    expect(fs.existsSync(getConfigFile())).toBe(true);
    expect(readConfig()).toEqual(cfg);
  });

  it("creates the data directory if it does not exist yet", () => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    expect(fs.existsSync(tmpDataDir)).toBe(false);
    writeConfig({ category_links: "a" });
    expect(fs.existsSync(tmpDataDir)).toBe(true);
  });
});
