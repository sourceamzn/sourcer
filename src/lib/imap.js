"use strict";
/* Cliente IMAP minimo (sin dependencias) para leer respuestas en el buzon
   de cPanel (Dovecot). Solo lo necesario:
   LOGIN, LIST, SELECT, UID SEARCH, UID FETCH (cabeceras + inicio del texto),
   APPEND (copia en "Enviados" de lo que manda la herramienta) y LOGOUT.
   Lee los literales {n} por bytes para no romper con acentos. */

const tls = require("tls");
const net = require("net");

function quote(s) { return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }

class Imap {
  constructor(opts) { this.opts = opts || {}; this.buf = Buffer.alloc(0); this.seq = 0; this.waiters = []; this.sock = null; }

  connect() {
    const o = this.opts;
    const port = Number(o.port) || 993;
    const secure = o.secure != null ? o.secure : port === 993;
    return new Promise((resolve, reject) => {
      const onReady = () => {
        this.sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
        this._waitGreeting = resolve;
        this._pump();
      };
      this.sock = secure
        ? tls.connect({ host: o.host, port: port, servername: o.host, rejectUnauthorized: o.rejectUnauthorized !== false }, onReady)
        : net.connect({ host: o.host, port: port }, onReady);
      this.sock.setTimeout(o.timeoutMs || 30000, () => this.sock.destroy(new Error("imap_timeout")));
      this.sock.once("error", (e) => { reject(e); this.waiters.splice(0).forEach((w) => w.reject(e)); });
      this.sock.once("close", () => { this.waiters.splice(0).forEach((w) => w.reject(new Error("imap_cerrado"))); });
    });
  }

  /* Extrae del buffer respuestas completas. Una "linea logica" puede llevar
     literales {n}\r\n<n bytes> en medio. */
  _pump() {
    while (true) {
      let pos = 0;
      const parts = [];
      let complete = false;
      while (true) {
        const nl = this.buf.indexOf("\r\n", pos);
        if (nl === -1) break;
        const lineStr = this.buf.slice(pos, nl).toString("utf8");
        const lit = lineStr.match(/\{(\d+)\}$/);
        if (lit) {
          const n = parseInt(lit[1], 10);
          if (this.buf.length < nl + 2 + n) break;
          parts.push({ text: lineStr, literal: this.buf.slice(nl + 2, nl + 2 + n) });
          pos = nl + 2 + n;
          continue;
        }
        parts.push({ text: lineStr });
        pos = nl + 2;
        complete = true;
        break;
      }
      if (!complete) return;
      this.buf = this.buf.slice(pos);
      this._onResponse(parts);
    }
  }

  _onResponse(parts) {
    const first = parts[0].text;
    if (this._waitGreeting) { const g = this._waitGreeting; this._waitGreeting = null; g(first); return; }
    const w = this.waiters[0];
    if (!w) return;
    if (first.startsWith("+")) { if (w.onContinue) w.onContinue(); return; }
    const m = first.match(/^(A\d+) (OK|NO|BAD)\b(.*)$/);
    if (m && m[1] === w.tag) {
      this.waiters.shift();
      if (m[2] === "OK") w.resolve({ untagged: w.untagged, status: m[3].trim() });
      else w.reject(new Error("imap_" + m[2].toLowerCase() + ": " + m[3].trim().slice(0, 200)));
      return;
    }
    w.untagged.push(parts);
  }

  cmd(text, opts) {
    const tag = "A" + (++this.seq);
    return new Promise((resolve, reject) => {
      const w = { tag: tag, untagged: [], resolve: resolve, reject: reject };
      if (opts && opts.literal) {
        w.onContinue = () => { this.sock.write(opts.literal); this.sock.write("\r\n"); };
      }
      this.waiters.push(w);
      this.sock.write(tag + " " + text + "\r\n");
    });
  }

  async login(user, pass) { return this.cmd("LOGIN " + quote(user) + " " + quote(pass)); }

  async list() {
    const r = await this.cmd('LIST "" "*"');
    return r.untagged.map((p) => {
      const t = p[0].text;
      const m = t.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i);
      if (!m) return null;
      let name = m[2].trim();
      if (p[0].literal) name = p[0].literal.toString("utf8");
      name = name.replace(/^"|"$/g, "");
      return { flags: m[1], name: name };
    }).filter(Boolean);
  }

  async select(box) {
    const r = await this.cmd("SELECT " + quote(box || "INBOX"));
    let uidValidity = null, uidNext = null;
    r.untagged.forEach((p) => {
      const t = p[0].text;
      const a = t.match(/UIDVALIDITY (\d+)/i); if (a) uidValidity = Number(a[1]);
      const b = t.match(/UIDNEXT (\d+)/i); if (b) uidNext = Number(b[1]);
    });
    return { uidValidity: uidValidity, uidNext: uidNext };
  }

  async uidSearch(criteria) {
    const r = await this.cmd("UID SEARCH " + criteria);
    const out = [];
    r.untagged.forEach((p) => {
      const m = p[0].text.match(/^\* SEARCH ?(.*)$/i);
      if (m && m[1]) m[1].trim().split(/\s+/).forEach((x) => { const n = Number(x); if (n) out.push(n); });
    });
    return out;
  }

  /* Cabeceras + primeros bytes del texto de cada UID. */
  async fetchHeaders(uids, textBytes) {
    if (!uids.length) return [];
    const items = "UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING AUTO-SUBMITTED X-AUTORESPOND X-AUTOREPLY)]" + (textBytes ? " BODY.PEEK[TEXT]<0." + textBytes + ">" : "");
    const r = await this.cmd("UID FETCH " + uids.join(",") + " (" + items + ")");
    const out = [];
    r.untagged.forEach((parts) => {
      const head = parts[0].text;
      if (!/FETCH/i.test(head)) return;
      const all = parts.map((p) => p.text).join(" ");
      const um = all.match(/UID (\d+)/i);
      const msg = { uid: um ? Number(um[1]) : null, header: "", text: "" };
      parts.forEach((p) => {
        if (!p.literal) return;
        if (/HEADER\.FIELDS/i.test(p.text)) msg.header = p.literal.toString("utf8");
        else if (/BODY\[TEXT\]/i.test(p.text)) msg.text = p.literal.toString("utf8");
      });
      out.push(msg);
    });
    return out;
  }

  /* Tamano y mensaje completo de un UID (para leer adjuntos). null si supera maxBytes. */
  async fetchFull(uid, maxBytes) {
    const sz = await this.cmd("UID FETCH " + Number(uid) + " (RFC822.SIZE)");
    let size = 0;
    sz.untagged.forEach((parts) => { const m = parts.map((p) => p.text).join(" ").match(/RFC822\.SIZE (\d+)/i); if (m) size = Number(m[1]); });
    if (maxBytes && size > maxBytes) return { size: size, raw: null };
    const r = await this.cmd("UID FETCH " + Number(uid) + " (BODY.PEEK[])");
    let raw = null;
    r.untagged.forEach((parts) => { parts.forEach((p) => { if (p.literal && /BODY\[\]/i.test(p.text)) raw = p.literal; }); });
    return { size: size, raw: raw };
  }

  async append(box, raw, flags) {
    const data = Buffer.from(raw, "utf8");
    return this.cmd("APPEND " + quote(box) + " (" + (flags || "\\Seen") + ") {" + data.length + "}", { literal: data });
  }

  async logout() { try { await this.cmd("LOGOUT"); } catch (e) {} try { this.sock.end(); } catch (e) {} }
}

/* ---------- utilidades de cabeceras ---------- */
function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_, cs, enc, txt) {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(txt, "base64").toString(/utf-?8/i.test(cs) ? "utf8" : "latin1");
      const q = txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
      return /utf-?8/i.test(cs) ? Buffer.from(q, "latin1").toString("utf8") : q;
    } catch (e) { return txt; }
  }).replace(/\?=\s+=\?/g, "");
}
function parseHeaders(raw) {
  const out = {};
  String(raw || "").replace(/\r\n[ \t]+/g, " ").split(/\r?\n/).forEach(function (l) {
    const i = l.indexOf(":");
    if (i <= 0) return;
    const k = l.slice(0, i).trim().toLowerCase();
    out[k] = decodeWords(l.slice(i + 1).trim());
  });
  return out;
}
function emailOf(s) {
  const m = String(s || "").match(/<([^>]+)>/) || String(s || "").match(/([^\s<>"]+@[^\s<>"]+)/);
  return m ? m[1].trim().toLowerCase() : "";
}
/* Texto legible del principio del cuerpo (plano, base64 o quoted-printable). */
function readableText(header, text, max) {
  let t = String(text || "");
  const h = parseHeaders(header);
  const cte = String(h["content-transfer-encoding"] || "").toLowerCase();
  /* Multipart: se toma la primera parte text/plain. */
  const part = t.match(/Content-Type:\s*text\/plain[^\n]*\n(?:[^\n]*\n)*?(?:Content-Transfer-Encoding:\s*([\w-]+)[^\n]*\n)?(?:[^\n]*\n)*?\r?\n([\s\S]*?)(?:\r?\n--|$)/i);
  let enc = cte;
  if (part) { t = part[2]; enc = String(part[1] || "").toLowerCase() || enc; }
  try {
    if (enc === "base64") t = Buffer.from(t.replace(/\s+/g, ""), "base64").toString("utf8");
    else if (enc === "quoted-printable") t = Buffer.from(t.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, function (m, x) { return String.fromCharCode(parseInt(x, 16)); }), "latin1").toString("utf8");
  } catch (e) {}
  t = t.replace(/<[^>]+>/g, " ");
  /* Se corta el texto citado ("El ... escribio:", lineas con >). */
  t = t.split(/\n>|\nEl .{5,80} escribi[oó]:|\nOn .{5,80} wrote:|-----Original Message-----|-----Mensaje original-----/i)[0];
  return t.replace(/\s+/g, " ").trim().slice(0, max || 600);
}

module.exports = { Imap, parseHeaders, emailOf, decodeWords, readableText, quote };
