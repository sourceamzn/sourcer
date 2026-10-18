/* Evita que una URL de un buscador o de una oferta apunte a la red interna
   (SSRF): solo se descargan http/https publicos. */
function isSafeRemoteUrl(value) {
  let u;
  try { u = new URL(String(value || "")); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = String(u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

async function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { jsonFetch, isSafeRemoteUrl };
