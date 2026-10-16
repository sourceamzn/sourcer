/* Traduccion ligera (MyMemory, gratis, sin clave) para buscar en 1688 (zh) y
   Alibaba / Made-in-China (en). Cacheada en memoria; si falla, devuelve el
   texto original para no romper la busqueda. */

const { jsonFetch } = require("./http");

const cache = new Map();
const CJK = /[\u3400-\u9fff]/;

function stripBrand(text, brand) {
  let t = String(text || "");
  const b = String(brand || "").trim();
  if (b.length >= 2) t = t.replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  return t.replace(/[()\[\]{},;:|/\\"'*+®™]+/g, " ").replace(/\s+/g, " ").trim();
}

/* Titulo de Amazon -> consulta corta y generica (sin marca, max ~8 palabras). */
function genericQuery(body) {
  const b = body || {};
  const base = stripBrand(b.name || b.query || "", b.brand);
  const words = base.split(" ").filter(Boolean).slice(0, 8);
  return words.join(" ");
}

async function translate(text, target) {
  const src = String(text || "").trim().slice(0, 300);
  if (!src) return src;
  const lp = target === "zh" ? "es|zh-CN" : "es|en";
  const key = lp + "::" + src.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const r = await jsonFetch(
    "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(src) + "&langpair=" + encodeURIComponent(lp),
    { method: "GET", headers: { Accept: "application/json" } },
    8000
  );
  let out = src;
  const t = r.ok && r.data && r.data.responseData && r.data.responseData.translatedText;
  if (t && typeof t === "string" && !/MYMEMORY WARNING|INVALID/i.test(t)) {
    if (target === "zh" ? CJK.test(t) : true) out = t.trim();
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

/* lang: "zh" | "en" | "es" (sin traducir, solo sin marca) */
async function marketQuery(body, lang) {
  const g = genericQuery(body) || String((body && body.query) || "").trim();
  if (!g || lang === "es") return g;
  try {
    return await translate(g, lang);
  } catch (e) {
    return g;
  }
}

module.exports = { translate, marketQuery, genericQuery, stripBrand };
