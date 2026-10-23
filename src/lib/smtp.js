"use strict";
/* Cliente SMTP minimo (sin dependencias) para el correo de cPanel.
   - Puerto 465: TLS directo. Puertos 587/25: STARTTLS.
   - AUTH PLAIN o LOGIN.
   - Mensaje text/plain UTF-8 en base64, con Message-ID propio e
     In-Reply-To/References para que los seguimientos vayan en el mismo hilo.
   buildMessage() es puro (se prueba sin red). */

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const os = require("os");

function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }
function encWord(s) {
  s = String(s || "");
  return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(s) + "?=";
}
function addr(name, email) {
  return name ? (encWord(String(name).replace(/["\r\n]/g, "")) + " <" + email + ">") : ("<" + email + ">");
}
function wrap76(s) { return String(s).replace(/(.{76})/g, "$1\r\n"); }
function domainOf(email) { return String(email || "").split("@")[1] || "localhost"; }
function newMessageId(from) {
  return "<" + Date.now().toString(36) + "." + crypto.randomBytes(8).toString("hex") + "@" + domainOf(from) + ">";
}
function rfcDate(d) {
  d = d || new Date();
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/* m: { fromName, from, to, subject, text, messageId, inReplyTo, references[], replyTo, listUnsubscribe } */
function buildMessage(m) {
  const id = m.messageId || newMessageId(m.from);
  const h = [];
  h.push("From: " + addr(m.fromName, m.from));
  h.push("To: " + addr(m.toName || "", m.to));
  if (m.replyTo) h.push("Reply-To: " + addr("", m.replyTo));
  h.push("Subject: " + encWord(m.subject || ""));
  h.push("Date: " + rfcDate(m.date));
  h.push("Message-ID: " + id);
  if (m.inReplyTo) h.push("In-Reply-To: " + m.inReplyTo);
  const refs = (m.references || []).filter(Boolean);
  if (refs.length) h.push("References: " + refs.join(" "));
  if (m.listUnsubscribe) h.push("List-Unsubscribe: <mailto:" + m.listUnsubscribe + "?subject=baja>");
  h.push("MIME-Version: 1.0");
  h.push("Content-Type: text/plain; charset=UTF-8; format=flowed");
  h.push("Content-Transfer-Encoding: base64");
  h.push("X-Mailer: sourcing-fba-outreach");
  const body = wrap76(b64(String(m.text || "").replace(/\r?\n/g, "\r\n")));
  return { messageId: id, raw: h.join("\r\n") + "\r\n\r\n" + body + "\r\n" };
}

/* Lector de respuestas SMTP multilinea ("250-...", "250 ..."). */
function reader(sock) {
  let buf = "";
  let waiting = null;
  const queue = [];
  function pump() {
    while (true) {
      const lines = buf.split("\r\n");
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) { end = i; break; }
      }
      if (end === -1) return;
      const resp = lines.slice(0, end + 1);
      buf = lines.slice(end + 1).join("\r\n");
      const code = parseInt(resp[end].slice(0, 3), 10);
      const out = { code: code, text: resp.join("\n") };
      if (waiting) { const w = waiting; waiting = null; w(out); } else queue.push(out);
    }
  }
  const onData = function (d) { buf += d.toString("utf8"); pump(); };
  sock.on("data", onData);
  return {
    next: function () {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise(function (res) { waiting = res; });
    },
    detach: function () { sock.removeListener("data", onData); }
  };
}

function connect(opts) {
  return new Promise(function (resolve, reject) {
    const port = Number(opts.port) || 465;
    const implicit = opts.secure != null ? opts.secure : port === 465;
    const done = function (sock) { resolve({ sock: sock, implicit: implicit }); };
    const sock = implicit
      ? tls.connect({ host: opts.host, port: port, servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized !== false }, function () { done(sock); })
      : net.connect({ host: opts.host, port: port }, function () { done(sock); });
    sock.setTimeout(opts.timeoutMs || 30000, function () { sock.destroy(new Error("smtp_timeout")); });
    sock.once("error", reject);
  });
}

/* opts: { host, port, secure, user, pass, timeoutMs, rejectUnauthorized }
   msg: ver buildMessage. Devuelve { ok, messageId, response } o lanza Error. */
/* Railway (planes Free/Trial/Hobby) bloquea las conexiones SMTP salientes.
   Con MAIL_RELAY_URL el mensaje ya montado se entrega por HTTPS a un PHP
   (relay-correo.php) alojado en el propio hosting del correo, que lo envia
   por SMTP local con la misma cuenta. Mismo remitente, misma firma DKIM. */
async function sendViaRelay(opts, msg) {
  const built = buildMessage(msg);
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 45000);
  let res, j = null, text = "";
  try {
    res = await fetch(opts.relayUrl, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "User-Agent": "SourcingFBA-relay/1" },
      body: JSON.stringify({ secret: opts.relaySecret || "", host: opts.relayHost || "localhost", port: Number(opts.relayPort) || 465, user: opts.user, pass: opts.pass, from: msg.from, to: [msg.to], raw: built.raw })
    });
    text = await res.text();
    try { j = JSON.parse(text); } catch (e) {}
  } catch (e) {
    throw new Error("relay_sin_conexion: " + String((e && e.name === "AbortError") ? "tiempo agotado" : (e && e.message) || e).slice(0, 150));
  } finally { clearTimeout(t); }
  if (!res.ok || !j || !j.ok) throw new Error("relay_" + (res && res.status) + ": " + String((j && j.reason) || text || "sin respuesta").slice(0, 200));
  return { ok: true, messageId: built.messageId, raw: built.raw, response: String(j.response || "").slice(0, 200), via: "relay" };
}

async function send(opts, msg) {
  if (opts && opts.relayUrl) return sendViaRelay(opts, msg);
  const built = buildMessage(msg);
  let { sock, implicit } = await connect(opts);
  let r = reader(sock);
  const write = function (s) { sock.write(s + "\r\n"); };
  async function expect(cmd, okCodes) {
    if (cmd != null) write(cmd);
    const resp = await r.next();
    if (okCodes.indexOf(resp.code) === -1) {
      const safe = cmd && /^AUTH|^[A-Za-z0-9+/=]{12,}$/.test(cmd) ? "AUTH ***" : cmd;
      throw new Error("smtp_" + resp.code + " (" + (safe || "saludo") + "): " + resp.text.slice(0, 200));
    }
    return resp;
  }
  try {
    await expect(null, [220]);
    const me = opts.ehlo || os.hostname() || "localhost";
    let ehlo = await expect("EHLO " + me, [250]);
    if (!implicit && /STARTTLS/i.test(ehlo.text)) {
      await expect("STARTTLS", [220]);
      r.detach();
      sock = await new Promise(function (res, rej) {
        const s2 = tls.connect({ socket: sock, servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized !== false }, function () { res(s2); });
        s2.once("error", rej);
      });
      r = reader(sock);
      ehlo = await expect("EHLO " + me, [250]);
    }
    if (opts.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await expect("AUTH PLAIN " + b64("\u0000" + opts.user + "\u0000" + opts.pass), [235]);
      } else {
        await expect("AUTH LOGIN", [334]);
        await expect(b64(opts.user), [334]);
        await expect(b64(opts.pass), [235]);
      }
    }
    await expect("MAIL FROM:<" + msg.from + ">", [250]);
    await expect("RCPT TO:<" + msg.to + ">", [250, 251]);
    await expect("DATA", [354]);
    /* Dot-stuffing: una linea que empieza por "." se dobla. */
    sock.write(built.raw.replace(/\r\n\./g, "\r\n..") + ".\r\n");
    const fin = await expect(null, [250]);
    try { write("QUIT"); } catch (e) {}
    return { ok: true, messageId: built.messageId, raw: built.raw, response: fin.text.slice(0, 200) };
  } finally {
    setTimeout(function () { try { sock.end(); sock.destroy(); } catch (e) {} }, 200);
  }
}

module.exports = { send, buildMessage, newMessageId, encWord };
