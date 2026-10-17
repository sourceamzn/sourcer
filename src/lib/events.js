/* Registro de eventos en memoria (ultimos MAX) para auditar el sistema en vivo.
   Nunca guarda claves ni tokens: todo texto pasa por scrub(). */

const MAX = 500;
const buf = [];
let seq = 0;

function scrub(v, n) {
  let s = typeof v === "string" ? v : (v === undefined ? "" : JSON.stringify(v));
  s = String(s || "")
    .replace(/(token|key|apikey|api_key|authorization|secret|password)(["'\s:=]+)([^\s"'&,}]{6,})/gi, "$1$2***")
    .replace(/\b(apify_api_|sk-|pk_)[A-Za-z0-9_\-]{8,}/g, "***");
  return s.slice(0, n || 400);
}

function clean(data) {
  const out = {};
  Object.keys(data || {}).forEach(function (k) {
    const v = data[k];
    if (v === null || v === undefined) return;
    out[k] = typeof v === "number" || typeof v === "boolean" ? v : scrub(v, 400);
  });
  return out;
}

/* kind: apify | keepa | source | job | reject | client | error ... */
function add(kind, data) {
  seq += 1;
  buf.push({ n: seq, t: new Date().toISOString(), kind: String(kind || "evt"), d: clean(data) });
  if (buf.length > MAX) buf.shift();
}

function list(opts) {
  opts = opts || {};
  let out = buf;
  if (opts.kind) out = out.filter(function (e) { return e.kind === opts.kind; });
  if (opts.job) out = out.filter(function (e) { return e.d && e.d.job === opts.job; });
  if (opts.session) out = out.filter(function (e) { return e.d && e.d.session === opts.session; });
  if (opts.since) out = out.filter(function (e) { return e.n > opts.since; });
  const lim = Math.min(Math.max(Number(opts.limit) || 200, 1), MAX);
  return out.slice(-lim);
}

function enabled() {
  return !!process.env.DEBUG_TOKEN;
}

/* Middleware: exige DEBUG_TOKEN (cabecera x-debug-token o ?token=). Sin variable, desactivado. */
function guard(req, res, next) {
  const tk = process.env.DEBUG_TOKEN;
  if (!tk) return res.status(404).json({ ok: false, reason: "debug_desactivado" });
  const got = req.headers["x-debug-token"] || (req.query && req.query.token) || "";
  if (String(got) !== String(tk)) return res.status(401).json({ ok: false, reason: "token_invalido" });
  next();
}

module.exports = { add, list, guard, enabled, scrub };
