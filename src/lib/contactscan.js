"use strict";
/* Busca los datos de contacto de un fabricante/distribuidor en su web:
   la pagina encontrada, la portada y hasta 4 paginas de "contacto",
   "aviso legal", "quienes somos", "distribuidores/profesionales".
   El aviso legal en Espana obliga a publicar razon social, CIF y email,
   asi que casi siempre hay al menos un correo. Devuelve emails ordenados
   (comerciales primero, del propio dominio primero), telefonos, WhatsApp,
   CIF/razon social si aparecen y la URL del formulario de contacto. */

const { jsonFetch, isSafeRemoteUrl } = require("./http");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LINK_RE = /(contact|contacto|aviso[-_ ]?legal|legal|quienes[-_ ]?somos|about|empresa|distribuidor|profesional|b2b|mayorista|wholesale|atencion[-_ ]?al[-_ ]?cliente)/i;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|sentry|wixpress|example\.|@2x|domain\.com|tudominio|yourdomain|email\.com$|ejemplo/i;
const SALES = /^(ventas|comercial|pedidos|sales|b2b|mayorista|distribuidores|distribucion|distributor|dealer|export|orders|trade|vertrieb|verkauf|commercial|vendite|vendas|compras|clientes|wholesale)/i;
/* Buzones que no gestionan altas de clientes: al final (el plan pide evitarlos). */
const AVOID = /^(soporte|support|sat|tecnico|technical|tech|rma|garantia|warranty|atencion|atencionalcliente|customerservice|service|servicio|rrhh|hr|empleo|jobs|careers|trabajo|privacidad|privacy|lopd|dpo|rgpd|gdpr|legal|noreply|no-reply|facturacion|billing|webmaster|prensa|press|marketing)/i;

function stripTags(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#64;|&#x40;/g, "@").replace(/\s+/g, " ");
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

async function fetchHtml(url, ms) {
  if (!isSafeRemoteUrl(url)) return null;
  const r = await jsonFetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "es-ES,es;q=0.9" } }, ms || 8000);
  return r && r.ok && typeof r.data === "string" ? r.data.slice(0, 800000) : null;
}

function extract(html, baseUrl, acc) {
  const raw = String(html || "");
  const text = stripTags(raw);
  /* Correos: mailto y texto (incluye "ventas [at] dominio.es"). */
  const found = [];
  (raw.match(/mailto:([^"'?\s>]+)/gi) || []).forEach(function (m) { found.push(decodeURIComponent(m.slice(7))); });
  (text.replace(/\s*\[\s*(?:at|arroba)\s*\]\s*/gi, "@").replace(/\s*\(\s*(?:at|arroba)\s*\)\s*/gi, "@").match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []).forEach(function (e) { found.push(e); });
  found.forEach(function (e) {
    e = String(e).trim().toLowerCase().replace(/[.,;:]+$/, "");
    if (!e || BAD_EMAIL.test(e) || acc.emails.indexOf(e) !== -1) return;
    acc.emails.push(e);
  });
  /* WhatsApp: enlaces wa.me / api.whatsapp.com. */
  (raw.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)(\+?\d{8,15})/gi) || []).forEach(function (m) {
    const d = m.replace(/\D/g, "");
    if (d && acc.whatsapp.indexOf(d) === -1) acc.whatsapp.push(d);
  });
  /* Telefonos: tel: y numeros espanoles visibles. */
  (raw.match(/tel:([+\d\s().\-]{8,20})/gi) || []).forEach(function (m) {
    const d = m.slice(4).replace(/[^\d+]/g, "");
    if (d.replace(/\D/g, "").length >= 9 && acc.phones.indexOf(d) === -1) acc.phones.push(d);
  });
  (text.match(/(?:\+34[\s.]?)?[6789]\d{2}[\s.]?\d{2,3}[\s.]?\d{2,3}[\s.]?\d{0,3}/g) || []).forEach(function (p) {
    const d = p.replace(/\D/g, "");
    if (d.length === 9 || (d.length === 11 && d.indexOf("34") === 0)) {
      const n = d.length === 9 ? "+34" + d : "+" + d;
      if (acc.phones.indexOf(n) === -1 && acc.phones.length < 6) acc.phones.push(n);
    }
  });
  /* CIF/NIF de empresa y razon social (aviso legal). */
  if (!acc.cif) { const c = text.match(/\b(?:CIF|NIF|C\.I\.F\.|N\.I\.F\.)\s*[:.]?\s*([ABCDEFGHJNPQRSUVW][-\s]?\d{7}[0-9A-J])\b/i); if (c) acc.cif = c[1].replace(/[-\s]/g, "").toUpperCase(); }
  if (!acc.company) { const s = text.match(/\b([A-Z][\w&.,'\- ]{2,60}?\s(?:S\.?L\.?U?|S\.?A\.?U?|S\.?L\.?L\.?|S\.?C\.?)\.?)(?=[\s,;])/); if (s) acc.company = s[1].trim(); }
  /* Idioma de la web (<html lang="de">) para elegir idioma y zona horaria. */
  if (!acc.pageLang) { const lg = raw.match(/<html[^>]*\slang\s*=\s*["']([a-zA-Z]{2})/i); if (lg) acc.pageLang = lg[1].toLowerCase(); }
  /* Formulario de contacto. */
  if (!acc.form && /<form[\s\S]{0,4000}?(?:email|correo|mensaje|message)/i.test(raw) && /contact|contacto/i.test(baseUrl)) acc.form = baseUrl;
  /* Enlaces a seguir. */
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,100}?)<\/a>/gi;
  let m;
  while ((m = re.exec(raw))) {
    const href = m[1], label = stripTags(m[2]);
    if (!(LINK_RE.test(href) || LINK_RE.test(label))) continue;
    try { links.push(new URL(href, baseUrl).href); } catch (e) {}
  }
  return links;
}

/* 0 ventas/distribuidores, 1 generico (info, contacto), 2 otros, 3 a evitar (soporte, SAT, RRHH...). */
const GENERIC = /^(info|hola|hello|contacto|contact|administracion|admin|office|oficina|mail|correo)/i;
function tierOf(e) {
  const local = String(e).split("@")[0];
  if (AVOID.test(local)) return 3;
  if (GENERIC.test(local)) return 1;
  if (SALES.test(local)) return 0;
  return 2;
}
function rankEmails(emails, host) {
  const base = String(host || "").split(".").slice(-2).join(".");
  return emails.slice().sort(function (a, b) {
    const da = a.split("@")[1] || "", db = b.split("@")[1] || "";
    const oa = base && da.endsWith(base) ? 0 : 1, ob = base && db.endsWith(base) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return tierOf(a) - tierOf(b);
  });
}

async function scan(url, opts) {
  opts = opts || {};
  const acc = { emails: [], phones: [], whatsapp: [], cif: "", company: "", form: "", pages: [], pageLang: "" };
  const host = hostOf(url);
  if (!host) return Object.assign(acc, { ok: false, reason: "url_invalida" });
  const origin = (function () { try { return new URL(url).origin; } catch (e) { return ""; } })();
  const queue = [url];
  if (origin && origin + "/" !== url) queue.push(origin + "/");
  const seen = {};
  const max = opts.maxPages || 6;
  while (queue.length && acc.pages.length < max) {
    const u = queue.shift();
    if (!u || seen[u] || hostOf(u) !== host) continue;
    seen[u] = 1;
    const html = await fetchHtml(u, opts.timeoutMs || 8000);
    if (!html) continue;
    acc.pages.push(u);
    const links = extract(html, u, acc);
    links.slice(0, 12).forEach(function (l) { if (!seen[l] && queue.length < 10) queue.push(l); });
  }
  acc.emails = rankEmails(acc.emails, host).slice(0, 8);
  /* Moviles espanoles (6/7) sin WhatsApp explicito: posible WhatsApp. */
  acc.mobiles = acc.phones.filter(function (p) { return /^\+34[67]\d{8}$/.test(p); });
  acc.ok = acc.pages.length > 0;
  if (!acc.ok) acc.reason = "web_inaccesible";
  return acc;
}

module.exports = { scan, extract, rankEmails };
