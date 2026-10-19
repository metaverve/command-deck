// Command-Central password gate (Vercel Routing Middleware, no dependencies).
// Protects every path except /login (GET form, POST check) and /logout.
// Env: CC_PASSWORD_HASH  = pbkdf2$sha256$<iterations>$<salt b64url>$<hash b64url>  (make with scripts/hash-password.mjs)
//      CC_SESSION_SECRET = random string, at least 32 characters
// Missing or malformed env => everything is locked (503). Nothing is ever served without a valid session.

export const config = { matcher: "/:path*" };

const COOKIE = "cc_session";
const SESSION_DAYS = 30;
const FAIL_DELAY_MS = 1000;
const MAX_FAILS = 5, WINDOW_MS = 15 * 60 * 1000; // per IP, per instance (best effort)
const fails = new Map();
const enc = new TextEncoder();

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
function safeEqual(a, b) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv() {
  const hash = (typeof process !== "undefined" && process.env && process.env.CC_PASSWORD_HASH) || "";
  const secret = (typeof process !== "undefined" && process.env && process.env.CC_SESSION_SECRET) || "";
  const m = /^pbkdf2\$sha256\$(\d{5,7})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{40,})$/.exec(hash);
  if (!m || secret.length < 32) return null;
  return { iterations: Number(m[1]), salt: unb64u(m[2]), expected: unb64u(m[3]), hash, secret };
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
// Session = "<expiry ms>.<hmac(expiry|hash)>". Including the hash means changing the password logs everyone out.
async function makeSession(env) { const exp = String(Date.now() + SESSION_DAYS * 864e5); return exp + "." + b64u(await hmac(env.secret, exp + "|" + env.hash)); }
async function validSession(env, value) {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!/^\d{13}$/.test(exp || "") || !sig || Number(exp) < Date.now()) return false;
  let given; try { given = unb64u(sig); } catch { return false; }
  return safeEqual(given, await hmac(env.secret, exp + "|" + env.hash));
}
function getCookie(req, name) {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return "";
}
function ipOf(req) { return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown"; }
const noStore = { "cache-control": "no-store", "x-robots-tag": "noindex", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[^\s\\]*$/.test(n) && !n.startsWith("/login") && !n.startsWith("/logout") ? n : "/");

function page(status, { error = "", next = "/", locked = false } = {}) {
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>Command Deck · Sign in</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0e1a;color:#e2e8f0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background-image:radial-gradient(ellipse 80% 50% at 20% -10%,rgba(56,189,248,.15),transparent),radial-gradient(ellipse 60% 40% at 80% 110%,rgba(99,102,241,.12),transparent)}
.card{width:min(380px,92vw);padding:28px;border-radius:20px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.14);box-shadow:0 8px 32px rgba(0,0,0,.35);backdrop-filter:blur(20px)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#67e8f9;padding:3px 10px;border-radius:99px;border:1px solid rgba(148,163,184,.14)}.dot{width:6px;height:6px;border-radius:50%;background:#22d3ee;box-shadow:0 0 8px #22d3ee}
h1{font-size:26px;margin:12px 0 4px;color:#fff;font-weight:600}p{margin:0 0 18px;color:#94a3b8;font-size:13px}
label{display:block;font-size:12px;color:#cbd5e1;margin-bottom:6px}input{width:100%;padding:11px 13px;border-radius:12px;border:1px solid rgba(148,163,184,.2);background:rgba(2,6,23,.6);color:#e2e8f0;font-size:15px;outline:none}
input:focus{border-color:rgba(56,189,248,.5);box-shadow:0 0 0 3px rgba(56,189,248,.2)}button{margin-top:14px;width:100%;padding:11px;border-radius:12px;border:1px solid rgba(34,211,238,.4);background:rgba(6,182,212,.22);color:#a5f3fc;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:rgba(6,182,212,.32)}.err{margin:0 0 14px;padding:9px 12px;border-radius:10px;font-size:13px;color:#fda4af;background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.3)}</style></head>
<body><main class="card"><span class="pill"><span class="dot"></span>PRIVATE</span><h1>Command Deck</h1>
${locked ? `<p>Sign-in isn't set up yet, so everything is locked. The site owner needs to finish setup.</p>` :
`<p>Enter the password to continue.</p>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form>`}
</main></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...noStore } });
}
const redirect = (to, extra = {}) => new Response(null, { status: 303, headers: { location: to, ...noStore, ...extra } });

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const env = readEnv();
  if (!env) return page(503, { locked: true });
  const cookieAttrs = "; Path=/; HttpOnly; Secure; SameSite=Lax";

  if (path === "/logout") return redirect("/login", { "set-cookie": COOKIE + "=" + cookieAttrs + "; Max-Age=0" });

  if (path === "/login") {
    if (request.method === "GET" || request.method === "HEAD") {
      if (await validSession(env, getCookie(request, COOKIE))) return redirect(safeNext(url.searchParams.get("next")));
      return page(200, { next: safeNext(url.searchParams.get("next")) });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: noStore });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403, headers: noStore });
    const ip = ipOf(request), now = Date.now();
    const rec = fails.get(ip);
    if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_FAILS) {
      await sleep(FAIL_DELAY_MS);
      return page(429, { error: "Too many wrong attempts. Wait 15 minutes and try again." });
    }
    let password = "", next = "/";
    try { const form = await request.formData(); password = String(form.get("password") || ""); next = safeNext(String(form.get("next") || "/")); } catch { /* bad body */ }
    const ok = password.length > 0 && password.length <= 1024 && safeEqual(await pbkdf2(password, env.salt, env.iterations), env.expected);
    if (!ok) {
      const r = rec && now - rec.first < WINDOW_MS ? rec : { first: now, count: 0 };
      r.count++; fails.set(ip, r);
      if (fails.size > 5000) fails.clear();
      await sleep(FAIL_DELAY_MS);
      return page(401, { error: "That password isn't right.", next });
    }
    fails.delete(ip);
    return redirect(next, { "set-cookie": COOKIE + "=" + (await makeSession(env)) + cookieAttrs + "; Max-Age=" + SESSION_DAYS * 86400 });
  }

  if (await validSession(env, getCookie(request, COOKIE))) return; // signed in: continue to the static file
  const accept = request.headers.get("accept") || "";
  if (request.method === "GET" && accept.includes("text/html")) return redirect("/login?next=" + encodeURIComponent(path + url.search));
  return new Response("Unauthorized", { status: 401, headers: noStore });
}
