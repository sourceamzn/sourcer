"use strict";

const crypto = require("crypto");
const { isSafeRemoteUrl } = require("./http");

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_MS = 5000;

function imageRef(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  const clean = raw.split("#")[0].split("?")[0];
  const amz = clean.match(/\/images\/i\/([^./]+)/i);
  if (amz) return { key: "amazon:" + amz[1].toLowerCase(), amazonId: amz[1], host: "media-amazon" };
  const host = (clean.match(/^https?:\/\/([^/]+)/i) || [])[1] || "";
  const file = clean.split("/").pop() || "";
  const base = file.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "")
    .replace(/[-_](?:\d+x\d+|sl\d+|ac_sl\d+|sx\d+|sy\d+).*$/i, "")
    .toLowerCase();
  return { key: host.toLowerCase() + ":" + base, host: host, base: base };
}

function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const type = buf.toString("ascii", 12, 16);
  if (type === "VP8X") {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (type === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
  }
  if (type === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
  }
  return null;
}

function imageSize(buf) {
  if (!buf || !buf.length) return null;
  return pngSize(buf) || jpegSize(buf) || gifSize(buf) || webpSize(buf);
}

async function fetchImage(url, opts) {
  opts = opts || {};
  if (!isSafeRemoteUrl(url)) return { ok: false, reason: "url_no_permitida" };
  const fetchImpl = opts.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, Math.max(500, opts.timeoutMs || MAX_MS));
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BruneaSourcing/1.0)", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!res || !res.ok) return { ok: false, status: (res && res.status) || 0 };
    const declared = Number((res.headers && res.headers.get && res.headers.get("content-length")) || 0);
    if (declared > MAX_BYTES) return { ok: false, reason: "imagen_demasiado_grande", status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { ok: false, reason: "imagen_demasiado_grande", status: res.status };
    const declaredType = String((res.headers && res.headers.get && res.headers.get("content-type")) || "").split(";")[0].trim().toLowerCase();
    return {
      ok: true,
      status: res.status,
      buffer: buf,
      bytes: buf.length,
      mime: /^image\//.test(declaredType) ? declaredType : mimeOf(buf)
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function mimeOf(buf) {
  if (!buf || !buf.length) return "image/jpeg";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/jpeg";
}

async function fetchInfo(url, opts) {
  const r = await fetchImage(url, opts);
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason };
  const dim = imageSize(r.buffer) || {};
  const ratio = dim.width && dim.height ? dim.width / dim.height : null;
  return {
    ok: true,
    status: r.status,
    hash: crypto.createHash("sha256").update(r.buffer).digest("hex"),
    bytes: r.bytes,
    width: dim.width || 0,
    height: dim.height || 0,
    ratio: ratio ? Math.round(ratio * 1000) / 1000 : null
  };
}

async function compareImages(srcUrl, offerUrl, opts) {
  opts = opts || {};
  const a = imageRef(srcUrl);
  const b = imageRef(offerUrl);
  if (!a || !b) return { state: "na", same: false, reason: "Falta la foto en el origen o en la oferta.", src: a, offer: b };
  if (a.key === b.key) return { state: "ok", same: true, reason: "La oferta usa la misma imagen que Amazon.", src: a, offer: b };
  const both = await Promise.all([
    fetchInfo(srcUrl, opts),
    fetchInfo(offerUrl, opts)
  ]);
  const ia = both[0], ib = both[1];
  const detail = { src: Object.assign({}, a, ia), offer: Object.assign({}, b, ib) };
  if (ia.ok && ib.ok) {
    if (ia.hash === ib.hash) return Object.assign({ state: "ok", same: true, reason: "La imagen es idéntica (misma huella)." }, detail);
    if (ia.ratio && ib.ratio) {
      const diff = Math.abs(ia.ratio - ib.ratio) / Math.max(ia.ratio, ib.ratio);
      if (diff <= 0.03) return Object.assign({ state: "compatible", same: false, reason: "Misma proporción de foto (no confirma por sí sola la identidad)." }, detail);
      if (diff >= 0.2) return Object.assign({ state: "warn", same: false, reason: "La foto tiene una proporción muy distinta: revísala antes de comprar." }, detail);
      return Object.assign({ state: "na", same: false, reason: "No se pudo confirmar que sea la misma foto." }, detail);
    }
    return Object.assign({ state: "na", same: false, reason: "Imágenes descargadas pero sin dimensiones legibles." }, detail);
  }
  return Object.assign({ state: "na", same: false, reason: "No se pudieron descargar las dos fotos para compararlas." }, detail);
}

function unknownWith(base, text) {
  const why = String(text || "").trim();
  let reason = String((base && base.reason) || "").trim();
  if (why) reason = why;
  if (!reason) reason = "No se pudo confirmar visualmente la foto.";
  if (!/sin confirmar visualmente/i.test(reason)) {
    reason = reason.replace(/[.\s]+$/, "") + ". Sin confirmar visualmente.";
  }
  return {
    state: "unknown", same: false, confirmed: false, provider: "none",
    cached: false, reason: reason, heuristic: base || null
  };
}

/* Orquestador de la foto: heuristicas siempre; vision solo si hay clave y
   presupuesto. La vision puede confirmar ("same") o descartar ("different");
   sin clave todo queda "unknown" y marcado como no confirmado. */
async function visualCompare(srcUrl, offerUrl, opts) {
  opts = opts || {};
  const base = await compareImages(srcUrl, offerUrl, opts);
  if (base.state === "ok" && base.same) {
    return {
      state: "same", same: true, confirmed: true, provider: "heuristica",
      cached: false, reason: base.reason || "La oferta usa la misma imagen que Amazon.",
      heuristic: base
    };
  }
  if (opts.enabled === false) return unknownWith(base, "Comparacion visual desactivada.");
  let vision = null;
  try { vision = require("./vision"); } catch (e) { vision = null; }
  if (!vision || !vision.available(opts)) {
    return unknownWith(base, "Falta una clave de vision (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY u OPENROUTER_API_KEY).");
  }
  if (opts.budget && typeof opts.budget.take === "function" && !opts.budget.take()) {
    return Object.assign(unknownWith(base, "Presupuesto de comparacion visual agotado."), { limited: true });
  }
  let v = null;
  try { v = await vision.compare(srcUrl, offerUrl, opts); }
  catch (e) { v = { state: "unknown", reason: "Error de vision: " + String((e && e.message) || e) }; }
  if (v && (v.state === "same" || v.state === "different")) {
    return Object.assign({ heuristic: base }, v);
  }
  return unknownWith(base, (v && v.reason) || "No se pudo confirmar visualmente.");
}

module.exports = { imageRef, imageSize, fetchInfo, fetchImage, compareImages, visualCompare };
