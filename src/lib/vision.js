"use strict";
/* Comparacion visual de fotos con un modelo multimodal.
   Es opcional: sin clave, imagecheck.visualCompare usa solo heuristicas y
   marca el resultado como "sin confirmar visualmente". Proveedores:
   anthropic | openai | gemini | openrouter. */

const imagecheck = require("./imagecheck");

let configLib;
function env(name) {
  return String(process.env[name] || "").trim();
}

function fallbackConfig() {
  return {
    enabled: env("IMAGE_AI_ENABLED") !== "false",
    provider: env("IMAGE_AI_PROVIDER") || "anthropic",
    max: Math.max(0, parseInt(env("IMAGE_AI_MAX") || "10", 10) || 0),
    timeoutMs: Math.min(Math.max(parseInt(env("IMAGE_AI_TIMEOUT_MS") || "12000", 10) || 12000, 2000), 30000),
    cacheMin: Math.max(0, parseInt(env("IMAGE_AI_CACHE_MIN") || "1440", 10) || 0),
    anthropic: { apiKey: env("ANTHROPIC_API_KEY"), model: env("ANTHROPIC_MODEL") || "claude-sonnet-4-6" },
    openai: { apiKey: env("OPENAI_API_KEY"), model: env("OPENAI_MODEL") || "gpt-4o-mini" },
    gemini: { apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL") || "gemini-2.0-flash" },
    openrouter: { apiKey: env("OPENROUTER_API_KEY"), model: env("OPENROUTER_MODEL") || "google/gemini-2.0-flash-001" }
  };
}

/* En tests sin node_modules (dotenv no instalado) se usan las variables de
   entorno directamente; en produccion manda config.js. */
function aiConfig() {
  if (configLib === undefined) {
    try { configLib = require("../config").config; } catch (e) { configLib = null; }
  }
  return (configLib && configLib.imageAi) || fallbackConfig();
}

const PROVIDERS = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-6" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models/", model: "gemini-2.0-flash" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemini-2.0-flash-001" }
};

const MAX_CACHE = 400;
const cache = new Map();

function setting(opts, key, fallback) {
  if (opts && opts[key] != null) return opts[key];
  const value = aiConfig()[key];
  return value == null ? fallback : value;
}

function providerOf(opts) {
  const id = String((opts && opts.provider) || aiConfig().provider || "anthropic").toLowerCase();
  const def = PROVIDERS[id];
  if (!def) return null;
  const cfg = aiConfig()[id] || {};
  const apiKey = String((opts && opts.apiKey) || cfg.apiKey || "").trim();
  const model = String((opts && opts.model) || cfg.model || def.model);
  return { id: id, apiKey: apiKey, model: model, url: def.url };
}

function available(opts) {
  if (setting(opts, "enabled", true) === false) return null;
  const p = providerOf(opts);
  if (!p || !p.apiKey) return null;
  return { provider: p.id, model: p.model };
}

function budget(max) {
  const limit = Math.max(0, parseInt(max, 10) || 0);
  return {
    max: limit,
    used: 0,
    take: function () {
      if (this.used >= this.max) return false;
      this.used++;
      return true;
    }
  };
}

function promptFor(opts) {
  const parts = [
    "Eres un verificador de identidad de producto para sourcing.",
    "Compara las dos fotos: A es la ficha de Amazon y B es la oferta del proveedor.",
    "Decide si muestran EXACTAMENTE el mismo producto: misma forma, modelo, color, tamano y pack.",
    "Diferencias de fondo, angulo, luz, marca de agua o recorte NO cuentan.",
    "Si B es un accesorio, repuesto, funda, filtro, otra variante, otro color o un pack distinto, NO es el mismo producto.",
    "Si no puedes verlo con seguridad, usa confidence baja.",
    "Responde SOLO con JSON: {\"same\":true|false,\"confidence\":\"alta\"|\"media\"|\"baja\",\"reason\":\"maximo 25 palabras en espanol\"}"
  ];
  const names = [];
  if (opts && opts.srcName) names.push("Origen: " + String(opts.srcName).slice(0, 160));
  if (opts && opts.offerName) names.push("Oferta: " + String(opts.offerName).slice(0, 160));
  if (names.length) parts.push(names.join(". ") + ".");
  return parts.join(" ");
}

function mimeOf(buf, declared) {
  if (declared && /^image\//.test(declared)) return declared;
  if (!buf || !buf.length) return "image/jpeg";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/jpeg";
}

async function postJson(url, headers, body, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error("HTTP " + res.status + (text ? ": " + text.slice(0, 160) : ""));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider(p, images, prompt, opts) {
  const fetchImpl = (opts && opts.fetch) || fetch;
  const timeoutMs = Math.max(2000, parseInt((opts && opts.apiTimeoutMs) || setting(opts, "timeoutMs", 12000), 10) || 12000);
  let raw;
  if (p.id === "anthropic") {
    raw = await postJson(p.url, {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01"
    }, {
      model: p.model,
      max_tokens: 200,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: images[0].mime, data: images[0].data } },
          { type: "image", source: { type: "base64", media_type: images[1].mime, data: images[1].data } },
          { type: "text", text: prompt }
        ]
      }]
    }, timeoutMs, fetchImpl);
    const data = JSON.parse(raw);
    return (data.content || []).map(function (x) { return x.text || ""; }).join(" ");
  }
  if (p.id === "gemini") {
    raw = await postJson(p.url + encodeURIComponent(p.model) + ":generateContent?key=" + encodeURIComponent(p.apiKey), {
      "content-type": "application/json"
    }, {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: images[0].mime, data: images[0].data } },
          { inline_data: { mime_type: images[1].mime, data: images[1].data } }
        ]
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 200 }
    }, timeoutMs, fetchImpl);
    const data = JSON.parse(raw);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.map(function (x) { return x.text || ""; }).join(" ");
  }
  const headers = {
    "content-type": "application/json",
    "authorization": "Bearer " + p.apiKey
  };
  if (p.id === "openrouter") {
    headers["HTTP-Referer"] = "https://tools.bruneagroup.com";
    headers["X-Title"] = "Brunea Sourcing";
  }
  raw = await postJson(p.url, headers, {
    model: p.model,
    temperature: 0,
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: "data:" + images[0].mime + ";base64," + images[0].data } },
        { type: "image_url", image_url: { url: "data:" + images[1].mime + ";base64," + images[1].data } }
      ]
    }]
  }, timeoutMs, fetchImpl);
  const data = JSON.parse(raw);
  const content = (((data.choices || [])[0] || {}).message || {}).content || "";
  return Array.isArray(content) ? content.map(function (x) { return x.text || ""; }).join(" ") : content;
}

function confidenceOf(value) {
  const s = String(value || "").toLowerCase();
  if (s === "alta" || s === "high") return "alta";
  if (s === "baja" || s === "low") return "baja";
  return "media";
}

function parseVerdict(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);
    if (typeof data.same !== "boolean") return null;
    return {
      same: data.same,
      confidence: confidenceOf(data.confidence),
      reason: String(data.reason || "").replace(/\s+/g, " ").trim().slice(0, 240)
    };
  } catch (e) {
    return null;
  }
}

function unknown(reason) {
  return { state: "unknown", same: false, confirmed: false, reason: reason, cached: false };
}

function cacheKey(p, srcUrl, offerUrl) {
  return p.id + "|" + p.model + "|" + srcUrl + "|" + offerUrl;
}

function cached(key, cacheMin) {
  if (!cacheMin) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}

function remember(key, value, cacheMin) {
  if (!cacheMin) return;
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first != null) cache.delete(first);
  }
  cache.set(key, { value: value, expires: Date.now() + cacheMin * 60000 });
}

async function compare(srcUrl, offerUrl, opts) {
  opts = opts || {};
  const p = providerOf(opts);
  if (!p || !p.apiKey) {
    return unknown("Falta la clave del proveedor de vision (" + String(aiConfig().provider || "anthropic") + ").");
  }
  if (setting(opts, "enabled", true) === false) return unknown("Comparacion visual desactivada.");
  const key = cacheKey(p, srcUrl, offerUrl);
  const cacheMin = Math.max(0, parseInt(setting(opts, "cacheMin", 1440), 10) || 0);
  const hit = cached(key, cacheMin);
  if (hit) return Object.assign({}, hit, { cached: true });

  const imageOpts = Object.assign({}, opts, { timeoutMs: (opts && (opts.imageTimeoutMs || opts.timeoutMs)) || 5000 });
  const both = await Promise.all([
    imagecheck.fetchImage(srcUrl, imageOpts),
    imagecheck.fetchImage(offerUrl, imageOpts)
  ]);
  if (!both[0].ok || !both[1].ok) {
    return unknown("No se pudieron descargar las dos fotos para la comparacion visual.");
  }
  const images = [
    { mime: mimeOf(both[0].buffer, both[0].mime), data: both[0].buffer.toString("base64") },
    { mime: mimeOf(both[1].buffer, both[1].mime), data: both[1].buffer.toString("base64") }
  ];
  let text;
  try {
    text = await callProvider(p, images, promptFor(opts), opts);
  } catch (e) {
    return Object.assign(unknown("No se pudo confirmar visualmente (" + String((e && e.message) || e).slice(0, 120) + ")."), { provider: p.id });
  }
  const verdict = parseVerdict(text);
  if (!verdict) {
    return Object.assign(unknown("La respuesta del modelo de vision no es concluyente."), { provider: p.id });
  }
  const base = { provider: p.id, model: p.model, confidence: verdict.confidence, reason: verdict.reason };
  let result;
  if (verdict.same && verdict.confidence !== "baja") {
    result = Object.assign(base, { state: "same", same: true, confirmed: true });
  } else if (!verdict.same && verdict.confidence === "alta") {
    result = Object.assign(base, { state: "different", same: false, confirmed: true });
  } else {
    result = Object.assign(base, unknown(verdict.reason || "Confianza insuficiente para confirmar la foto."));
    result.provider = p.id;
    result.model = p.model;
  }
  if (result.confirmed) remember(key, result, cacheMin);
  return result;
}

function clearCache() {
  cache.clear();
}

module.exports = { available, budget, compare, clearCache, providerOf, parseVerdict, confidenceOf };
