"use strict";
/* ¿Este dominio recibe correo? Consulta DNS (registros MX; si no hay, un
   registro A/AAAA, que tambien vale segun el estandar). Gratis y sin
   terceros. Evita rebotes que dañan la reputacion de tu dominio.
   Solo se considera "no recibe" cuando el DNS lo dice claramente
   (ENOTFOUND / ENODATA en todo). Ante un fallo de red se deja pasar. */

const dns = require("dns").promises;
const cache = require("./cache");

/* Maximo 4 s por consulta: un DNS lento nunca bloquea un envio (se deja pasar). */
function capped(p) {
  return Promise.race([p, new Promise(function (_, rej) { const t = setTimeout(function () { const e = new Error("timeout"); e.code = "ETIMEOUT"; rej(e); }, 4000); if (t.unref) t.unref(); })]);
}
let resolver = { mx: function (d) { return capped(dns.resolveMx(d)); }, a: function (d) { return capped(dns.resolve(d)); } };
const NOT_FOUND = /ENOTFOUND|ENODATA|NXDOMAIN|ESERVFAIL_NO/i;

function domainOf(email) {
  const m = String(email || "").trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : "";
}

/* -> { ok: true|false|null, domain, reason } (null = no se pudo comprobar) */
async function check(email) {
  const domain = domainOf(email);
  if (!domain) return { ok: false, domain: "", reason: "direccion_invalida" };
  const hit = await cache.get("mx", domain);
  if (hit) return hit;
  let out;
  try {
    const mx = await resolver.mx(domain);
    const valid = (mx || []).filter(function (x) { return x && x.exchange && x.exchange !== "."; });
    if (valid.length) out = { ok: true, domain: domain, reason: "mx" };
    else out = { ok: false, domain: domain, reason: "sin_mx" };
  } catch (e) {
    if (!NOT_FOUND.test(String(e && (e.code || e.message)))) return { ok: null, domain: domain, reason: "dns_error" };
    try {
      const a = await resolver.a(domain);
      out = a && a.length ? { ok: true, domain: domain, reason: "a" } : { ok: false, domain: domain, reason: "dominio_sin_correo" };
    } catch (e2) {
      if (!NOT_FOUND.test(String(e2 && (e2.code || e2.message)))) return { ok: null, domain: domain, reason: "dns_error" };
      out = { ok: false, domain: domain, reason: "dominio_no_existe" };
    }
  }
  await cache.set("mx", domain, out, (out.ok ? 7 : 1) * cache.DAY);
  return out;
}

module.exports = { check, domainOf, _setResolver: function (r) { resolver = r; } };
