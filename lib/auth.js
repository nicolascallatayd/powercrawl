import crypto from "node:crypto";

export const COOKIE_NAME = "pc_session";
const TOKEN_PAYLOAD = "authenticated";

function getAppPassword() {
  return process.env.APP_PASSWORD || "";
}

export function signToken(password) {
  return crypto.createHmac("sha256", password).update(TOKEN_PAYLOAD).digest("hex");
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(a || "", "utf8");
  const bufB = Buffer.from(b || "", "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Express middleware: 401s any request without a valid session cookie. */
export function requireAuth(req, res, next) {
  const appPassword = getAppPassword();
  if (!appPassword) {
    return res.status(500).json({ error: "APP_PASSWORD is not configured on the server" });
  }
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token && safeEqual(token, signToken(appPassword))) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

/** POST /api/login handler: checks the submitted password, sets the session cookie. */
export function login(req, res) {
  const appPassword = getAppPassword();
  if (!appPassword) {
    return res.status(500).json({ error: "APP_PASSWORD is not configured on the server" });
  }
  const submitted = (req.body && req.body.password) || "";
  if (!safeEqual(submitted, appPassword)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  res.cookie(COOKIE_NAME, signToken(appPassword), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
}

export function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
}
