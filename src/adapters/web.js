const { jsonFetch } = require("../lib/http");

const MAX_BYTES = 900 * 1024;

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.endsWith(".local")) return null;
    if (/^(10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

async function readOnce(url) {
  const out = await jsonFetch(
    url,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; sourcer/0.1; +https://github.com/hannansha/sourcer)" } },
    20000
  );
  if (out.ok && typeof out.data === "string" && out.data.replace(/\s/g, "").length > 120) {
    return { ok: true, status: out.status, text: out.data.slice(0, MAX_BYTES) };
  }
  return { ok: false, status: out.status || 0, error: out.error || "empty_content" };
}

const web = {
  id: "web",
  label: "Lectura web",
  kind: "infra",
  actions: {
    ping: async () => ({
      ok: true,
      configured: true,
      reason: null,
      note: "lectura web del lado del servidor (sin claves)"
    }),
    read: async (body) => {
      const url = safeUrl(body && (body.url || body.u));
      if (!url) {
        return { ok: false, reason: "invalid_or_blocked_url", hint: "Proporciona una URL http(s) publica." };
      }
      const direct = await readOnce(url);
      if (direct.ok) {
        return { ok: true, url, method: "directo", status: direct.status, bytes: direct.text.length, text: direct.text };
      }
      const proxied = await readOnce("https://r.jina.ai/" + url);
      if (proxied.ok) {
        return { ok: true, url, method: "r.jina.ai", status: proxied.status, bytes: proxied.text.length, text: proxied.text };
      }
      return { ok: false, reason: "fetch_failed", url, direct: direct.error, proxied: proxied.error };
    },
    search: async (body) => {
      const query = String((body && (body.query || body.q)) || "").trim();
      if (!query) return { ok: false, reason: "query_required" };
      const engine = body && body.engine === "bing" ? "bing" : "ddg";
      const target =
        engine === "bing"
          ? "https://www.bing.com/search?q=" + encodeURIComponent(query)
          : "https://duckduckgo.com/html/?q=" + encodeURIComponent(query);
      const res = await readOnce(target);
      if (!res.ok) return { ok: false, reason: "search_failed", engine, query, error: res.error };
      return { ok: true, engine, query, status: res.status, bytes: res.text.length, html: res.text };
    }
  }
};

module.exports = web;
