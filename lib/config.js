import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REQUIRED_FIELDS = ["category_links", "company_links", "website_url"];

export function getDataDir() {
  return process.env.POWERCRAWL_DATA_DIR || path.join(__dirname, "..", "data");
}
export function getConfigFile() {
  return path.join(getDataDir(), "config.json");
}
export function getOutputFile() {
  return path.join(getDataDir(), "leads.txt");
}

export function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Returns an array of missing/blank required selector field names ([] if valid). */
export function validateConfig(config) {
  if (!config || typeof config !== "object") return REQUIRED_FIELDS.slice();
  return REQUIRED_FIELDS.filter((field) => !String(config[field] || "").trim());
}

export function readConfig() {
  const file = getConfigFile();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeConfig(config) {
  ensureDataDir();
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2));
}
