import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import request from "supertest";

// vi.mock calls are hoisted above all imports (including the app.js import
// below), so any variable their factories close over must be created via
// vi.hoisted() rather than a plain top-level const — otherwise the factory
// runs against a not-yet-initialized binding when app.js's own require chain
// pulls these modules in during ESM linking, silently falling through to the
// real (unmocked) module instead.
const { fetchPageMock, anthropicCreateMock } = vi.hoisted(() => ({
  fetchPageMock: vi.fn(
    async (url) => `<html><body>fake page for ${url}</body></html>`,
  ),
  anthropicCreateMock: vi.fn(async () => ({
    content: [
      {
        text: JSON.stringify({
          start_url: "https://example.com",
          category_links: "a.cat",
          company_links: "a.company",
          website_url: "a.site",
          next_page: null,
          notes: "mocked",
        }),
      },
    ],
  })),
}));

vi.mock("../lib/httpFetch.js", () => ({
  fetchPage: (...args) => fetchPageMock(...args),
}));
vi.mock("../lib/anthropicClient.js", () => ({
  createClient: () => ({
    messages: { create: (...args) => anthropicCreateMock(...args) },
  }),
}));

import { createApp } from "../app.js";

const ORIGINAL_DATA_DIR = process.env.POWERCRAWL_DATA_DIR;
const ORIGINAL_APP_PASSWORD = process.env.APP_PASSWORD;
const ORIGINAL_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;

let tmpDataDir;
let app;

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "powercrawl-app-test-"));
  process.env.POWERCRAWL_DATA_DIR = tmpDataDir;
  process.env.APP_PASSWORD = "test-password";
  delete process.env.ANTHROPIC_MODEL;
  anthropicCreateMock.mockReset();
  anthropicCreateMock.mockResolvedValue({
    content: [
      {
        text: JSON.stringify({
          start_url: "https://example.com",
          category_links: "a.cat",
          company_links: "a.company",
          website_url: "a.site",
          next_page: null,
          notes: "mocked",
        }),
      },
    ],
  });
  app = createApp();
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  process.env.POWERCRAWL_DATA_DIR = ORIGINAL_DATA_DIR;
  process.env.APP_PASSWORD = ORIGINAL_APP_PASSWORD;
  if (ORIGINAL_ANTHROPIC_MODEL === undefined) {
    delete process.env.ANTHROPIC_MODEL;
  } else {
    process.env.ANTHROPIC_MODEL = ORIGINAL_ANTHROPIC_MODEL;
  }
});

async function login(agent) {
  const res = await agent
    .post("/api/login")
    .send({ password: "test-password" });
  expect(res.status).toBe(200);
}

describe("auth gate", () => {
  it("401s /api/config without a session", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(401);
  });

  it("401s /api/login with the wrong password", async () => {
    const res = await request(app)
      .post("/api/login")
      .send({ password: "nope" });
    expect(res.status).toBe(401);
  });

  it("allows /api/config after a successful login", async () => {
    const agent = request.agent(app);
    await login(agent);
    const res = await agent.get("/api/config");
    expect(res.status).toBe(200);
  });

  it("re-locks /api/config after logout", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.post("/api/logout");
    const res = await agent.get("/api/config");
    expect(res.status).toBe(401);
  });
});

describe("config validation", () => {
  it("rejects saving a config missing required selectors", async () => {
    const agent = request.agent(app);
    await login(agent);
    const res = await agent
      .post("/api/config")
      .send({ category_links: "a.cat" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company_links/);
    expect(res.body.error).toMatch(/website_url/);
  });

  it("saves and reads back a valid config", async () => {
    const agent = request.agent(app);
    await login(agent);
    const cfg = {
      category_links: "a.cat",
      company_links: "a.company",
      website_url: "a.site",
    };
    const saveRes = await agent.post("/api/config").send(cfg);
    expect(saveRes.status).toBe(200);
    const readRes = await agent.get("/api/config");
    expect(readRes.body).toMatchObject(cfg);
  });
});

describe("download", () => {
  it("404s when no leads file exists yet", async () => {
    const agent = request.agent(app);
    await login(agent);
    const res = await agent.get("/api/download");
    expect(res.status).toBe(404);
  });
});

describe("concurrency guard", () => {
  it("rejects a second scrape while one is in flight", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.post("/api/config").send({
      category_links: "a.cat",
      company_links: "a.company",
      website_url: "a.site",
      start_url: "https://example.com",
    });

    // supertest's Test object doesn't dispatch until .then()/.end() is called,
    // so wrap it in a Promise that starts immediately rather than awaiting it here.
    const first = new Promise((resolve, reject) => {
      agent.get("/api/scrape").then(resolve, reject);
    });
    // Fire the second request shortly after the first, while it should still be in flight.
    await new Promise((r) => setTimeout(r, 10));
    const second = await agent.get("/api/scrape");
    expect(second.status).toBe(409);

    await first;
  });
});

describe("scrape edge cases", () => {
  it("warns instead of silently succeeding when 0 categories match the selector", async () => {
    const agent = request.agent(app);
    await login(agent);
    await agent.post("/api/config").send({
      category_links: "a.cat",
      company_links: "a.company",
      website_url: "a.site",
      start_url: "https://example.com",
    });
    const res = await agent.get("/api/scrape");
    expect(res.status).toBe(200);
    expect(res.text).toContain("WARNING: 0 categories matched");
    expect(res.text).toContain('"type":"done"');
  });
});

describe("detect error handling", () => {
  it("emits an SSE error event (not a crash) when the homepage is unreachable", async () => {
    fetchPageMock.mockResolvedValueOnce(null);

    const agent = request.agent(app);
    await login(agent);
    const res = await agent
      .get("/api/detect")
      .query({ url: "https://unreachable.example" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Could not fetch URL");
  });

  it("does not crash and emits an SSE error event when the AI call fails", async () => {
    anthropicCreateMock.mockRejectedValueOnce(new Error("boom"));

    const agent = request.agent(app);
    await login(agent);
    const res = await agent
      .get("/api/detect")
      .query({ url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
  });

  it("falls back to a supported model when the preferred model is not found", async () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
    const unsupportedError = Object.assign(
      new Error("model: claude-sonnet-4-20250514"),
      {
        status: 404,
        type: "not_found_error",
      },
    );
    anthropicCreateMock
      .mockRejectedValueOnce(unsupportedError)
      .mockResolvedValueOnce({
        content: [
          {
            text: JSON.stringify({
              start_url: "https://example.com",
              category_links: "a.cat",
              company_links: "a.company",
              website_url: "a.site",
              next_page: null,
              notes: "fallback",
            }),
          },
        ],
      });

    const agent = request.agent(app);
    await login(agent);
    const res = await agent
      .get("/api/detect")
      .query({ url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"config"');
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);
    expect(anthropicCreateMock.mock.calls[1][0].model).toBe(
      "claude-3-5-sonnet-latest",
    );
  });

  it("succeeds and saves config on the happy path", async () => {
    const agent = request.agent(app);
    await login(agent);
    const res = await agent
      .get("/api/detect")
      .query({ url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"config"');
    expect(res.text).toContain('"type":"done"');
  });
});
