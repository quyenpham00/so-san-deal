// Single-admin login: password from ADMIN_PASSWORD, session in an HMAC-signed HttpOnly cookie.
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const COOKIE = "ssd_admin";
const MAX_AGE_S = 7 * 24 * 3600;

const sha = (s) => createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b));

export function createAuth({ password, secret, secureCookie = false }) {
  const key = secret || randomBytes(32).toString("hex");
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("base64url");
  const attempts = new Map(); // ip → {count, until}

  function readCookie(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return decodeURIComponent(v.join("="));
    }
    return null;
  }

  function isAdmin(req) {
    if (!password) return false;
    const c = readCookie(req);
    if (!c) return false;
    const [exp, mac] = c.split(".");
    if (!exp || !mac || Number(exp) < Date.now() / 1000) return false;
    return safeEqual(mac, sign(exp));
  }

  function setCookie(res, value, maxAge) {
    res.setHeader("Set-Cookie",
      `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`);
  }

  return {
    enabled: Boolean(password),
    isAdmin,

    login(req, res) {
      if (!password) return res.status(503).json({ error: "Chưa cấu hình ADMIN_PASSWORD trên máy chủ." });
      const ip = req.ip || "?";
      const a = attempts.get(ip);
      if (a && a.until > Date.now() && a.count >= 5) {
        return res.status(429).json({ error: "Sai mật khẩu quá nhiều lần. Thử lại sau 10 phút." });
      }
      if (!safeEqual(req.body?.password ?? "", password)) {
        const next = a && a.until > Date.now() ? a : { count: 0, until: Date.now() + 10 * 60_000 };
        next.count++;
        attempts.set(ip, next);
        return res.status(401).json({ error: "Sai mật khẩu." });
      }
      attempts.delete(ip);
      const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
      setCookie(res, `${exp}.${sign(exp)}`, MAX_AGE_S);
      res.json({ ok: true });
    },

    logout(req, res) {
      setCookie(res, "", 0);
      res.json({ ok: true });
    },

    /** Admin-only routes. Mutations also need the X-Requested-With header (CSRF guard on top of SameSite). */
    require(req, res, next) {
      if (!isAdmin(req)) return res.status(401).json({ error: "Cần đăng nhập quản trị." });
      if (req.method !== "GET" && req.get("x-requested-with") !== "fetch") {
        return res.status(403).json({ error: "Yêu cầu không hợp lệ." });
      }
      next();
    },
  };
}
