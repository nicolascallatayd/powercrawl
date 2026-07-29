import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requireAuth, login, logout, COOKIE_NAME, signToken } from "../lib/auth.js";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    cookies: {},
    cleared: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    cookie(name, value) { this.cookies[name] = value; return this; },
    clearCookie(name) { this.cleared.push(name); return this; },
  };
  return res;
}

describe("requireAuth / login / logout", () => {
  const OLD_ENV = process.env.APP_PASSWORD;

  beforeEach(() => {
    process.env.APP_PASSWORD = "correct-horse-battery-staple";
  });
  afterEach(() => {
    process.env.APP_PASSWORD = OLD_ENV;
  });

  it("500s requireAuth when APP_PASSWORD is not configured", () => {
    delete process.env.APP_PASSWORD;
    const req = { cookies: {} };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s a request with no session cookie", () => {
    const req = { cookies: {} };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s a request with an invalid session cookie", () => {
    const req = { cookies: { [COOKIE_NAME]: "garbage" } };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for a request with a valid session cookie", () => {
    const req = { cookies: { [COOKIE_NAME]: signToken(process.env.APP_PASSWORD) } };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("login() rejects an incorrect password", () => {
    const req = { body: { password: "wrong" } };
    const res = mockRes();
    login(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.cookies[COOKIE_NAME]).toBeUndefined();
  });

  it("login() sets a session cookie for the correct password", () => {
    const req = { body: { password: process.env.APP_PASSWORD } };
    const res = mockRes();
    login(req, res);
    expect(res.body).toEqual({ ok: true });
    expect(res.cookies[COOKIE_NAME]).toBe(signToken(process.env.APP_PASSWORD));
  });

  it("logout() clears the session cookie", () => {
    const res = mockRes();
    logout({}, res);
    expect(res.cleared).toContain(COOKIE_NAME);
    expect(res.body).toEqual({ ok: true });
  });
});
