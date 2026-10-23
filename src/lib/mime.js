"use strict";
/* Lector MIME minimo (sin dependencias) para sacar los ADJUNTOS de las
   respuestas de proveedores: tarifas en Excel/CSV/PDF. Trabaja en latin1
   (binario seguro) y decodifica base64 / quoted-printable. */

const imapLib = require("./imap");

const TARIFF_EXT = /\.(xlsx|xlsm|xls|ods|csv|tsv|txt|pdf)$/i;
const TARIFF_MIME = /(spreadsheet|excel|csv|pdf|opendocument)/i;
const MAX_FILE = 10 * 1024 * 1024;

function splitHead(s) {
  const i = s.search(/\r?\n\r?\n/);
  if (i === -1) return { head: s, body: "" };
  const m = s.slice(i).match(/^\r?\n\r?\n/);
  return { head: s.slice(0, i), body: s.slice(i + m[0].length) };
}
function headers(head) {
  const out = {};
  String(head || "").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach(function (l) {
    const i = l.indexOf(":");
    if (i > 0) out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  });
  return out;
}
function param(h, name) {
  const s = String(h || "");
  /* RFC 2231: filename*=utf-8''nombre%20con%20espacios (o troceado filename*0*=) */
  const ext = [];
  const re = new RegExp(name + "\\*(\\d+)?\\*?=\\s*(\"[^\"]*\"|[^;]+)", "gi");
  let m;
  while ((m = re.exec(s))) ext.push({ i: Number(m[1] || 0), v: m[2].replace(/^"|"$/g, "") });
  if (ext.length) {
    let v = ext.sort(function (a, b) { return a.i - b.i; }).map(function (x) { return x.v; }).join("");
    const cs = v.match(/^([\w-]*)'[\w-]*'/);
    if (cs) v = v.slice(cs[0].length);
    try { return Buffer.from(decodeURIComponent(v.replace(/%(?![0-9a-f]{2})/gi, "%25")), "utf8").toString("utf8"); } catch (e) { return v; }
  }
  const p = s.match(new RegExp("(?:^|;)\\s*" + name + "\\s*=\\s*(\"([^\"]*)\"|[^;]+)", "i"));
  if (!p) return "";
  return imapLib.decodeWords((p[2] != null ? p[2] : p[1]).trim());
}
function decode(body, cte) {
  const enc = String(cte || "").toLowerCase().trim();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, function (_, x) { return String.fromCharCode(parseInt(x, 16)); });
    return Buffer.from(s, "latin1");
  }
  return Buffer.from(body, "latin1");
}

/* Partes hoja del mensaje: [{ headers, contentType, filename, disposition, data(Buffer) }] */
function parts(raw, depth) {
  depth = depth || 0;
  const s = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw || "");
  const sp = splitHead(s);
  const h = headers(sp.head);
  const ct = h["content-type"] || "text/plain";
  if (/^multipart\//i.test(ct) && depth < 8) {
    const b = param(ct, "boundary");
    if (!b) return [];
    const chunks = sp.body.split("--" + b);
    const out = [];
    for (let i = 1; i < chunks.length; i++) {
      let c = chunks[i];
      if (/^--/.test(c)) break;
      c = c.replace(/^\r?\n/, "");
      out.push.apply(out, parts(c, depth + 1));
    }
    return out;
  }
  if (/^message\/rfc822/i.test(ct) && depth < 8) return parts(sp.body, depth + 1);
  const disp = h["content-disposition"] || "";
  const filename = param(disp, "filename") || param(ct, "name");
  return [{ headers: h, contentType: ct.split(";")[0].trim().toLowerCase(), disposition: disp.split(";")[0].trim().toLowerCase(), filename: filename, data: decode(sp.body, h["content-transfer-encoding"]) }];
}

/* Adjuntos que pueden ser una tarifa (Excel, CSV, PDF). */
function tariffAttachments(raw) {
  return parts(raw).filter(function (p) {
    if (!p.filename && p.disposition !== "attachment") return false;
    if (!(TARIFF_EXT.test(p.filename || "") || TARIFF_MIME.test(p.contentType))) return false;
    return p.data.length > 0 && p.data.length <= MAX_FILE;
  }).map(function (p) {
    return { filename: (p.filename || "adjunto").replace(/[\\/\r\n]+/g, "_").slice(0, 150), mime: p.contentType, size: p.data.length, data: p.data };
  });
}
function isMultipart(headerRaw) {
  const h = imapLib.parseHeaders(headerRaw);
  return /multipart\/(mixed|related|report)/i.test(h["content-type"] || "");
}

module.exports = { parts, tariffAttachments, isMultipart, param, MAX_FILE };
