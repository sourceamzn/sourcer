/* Adaptador de newsletters (canal del PDF).

   El PDF trata las newsletters como correos con ofertas puntuales: se leen, se
   extraen los productos y precios y se analizan con los mismos criterios. La
   lectura automatica de Gmail queda para una fase posterior; este adaptador
   procesa el correo ya volcado (EML/HTML/texto pegado o una URL publica). */

const { jsonFetch } = require("../lib/http");
const parse = require("../lib/parse");

function bodyOf(body) {
  return String((body && (body.eml || body.html || body.text || body.content)) || "");
}

function stripHeaders(eml) {
  const idx = eml.search(/\r?\n\r?\n/);
  return idx === -1 ? eml : eml.slice(idx);
}

function fromHtml(html, baseUrl) {
  const items = parse.productsFromJsonLd(html, baseUrl);
  if (items.length) return items;
  const out = [];
  const seen = {};
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = parse.attr(m[1], "href");
    const inner = m[2];
    if (!href || !/<img\b/i.test(inner)) continue;
    const url = parse.absUrl(baseUrl, href);
    const img = (inner.match(/<img\b([^>]*)>/i) || [])[1];
    const name = parse.stripTags(parse.attr(m[1], "title") || (img ? parse.attr(img, "alt") : "") || parse.stripTags(inner)).slice(0, 180);
    if (!name || name.length < 4) continue;
    const tail = html.slice(m.index, m.index + 400);
    const priceMatch = tail.match(/(?:€|EUR)\s*([\d.,]+)|([\d.,]+)\s*(?:€|EUR)/i);
    const key = url.split(/[?#]/)[0] || name;
    if (seen[key]) continue;
    seen[key] = true;
    out.push({
      name,
      url,
      image: img ? parse.absUrl(baseUrl, parse.attr(img, "src") || parse.attr(img, "data-src")) : "",
      brand: "",
      sku: "",
      ean: "",
      price: priceMatch ? parse.parsePrice(priceMatch[1] || priceMatch[2]) : null,
      oldPrice: null,
      currency: "EUR",
      description: ""
    });
  }
  return out;
}

function fromText(text) {
  const out = [];
  text.split(/\r?\n/).forEach(function (line) {
    const clean = parse.stripTags(line);
    const priceMatch = clean.match(/(?:€|EUR)?\s*([\d]+[.,][\d]{2})\s*(?:€|EUR)?/);
    const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/);
    const name = clean.replace(/([\d]+[.,][\d]{2})/, "").replace(/https?:\/\/\S+/g, "").trim();
    if (name.length >= 5 && priceMatch && priceMatch[1]) {
      out.push({ name: name.slice(0, 180), url: urlMatch ? urlMatch[0] : "", image: "", brand: "", sku: "", ean: "", price: parse.parsePrice(priceMatch[1]), oldPrice: null, currency: "EUR", description: "" });
    }
  });
  return out;
}

function toItems(raw, baseUrl) {
  return raw.map(function (p) {
    return {
      source: "newsletters",
      name: p.name || "",
      brand: p.brand || "",
      model: "",
      reference: p.sku || "",
      ean: parse.detectEan(p.ean, p.sku),
      price: p.price != null ? p.price : null,
      oldPrice: p.oldPrice != null ? p.oldPrice : null,
      stock: null,
      available: true,
      url: p.url || "",
      image: p.image || "",
      attrs: { description: p.description || "", currency: p.currency || "EUR", channel: "newsletter" },
      capturedAt: new Date().toISOString()
    };
  });
}

async function parseNewsletter(body) {
  body = body || {};
  let content = bodyOf(body);
  let baseUrl = String(body.url || "");
  if (!content && body.url) {
    const res = await jsonFetch(String(body.url), { method: "GET", headers: { Accept: "text/html, */*" } }, 25000);
    if (!res.ok) return { ok: false, reason: "url_http_" + res.status };
    content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }
  if (!content) return { ok: false, reason: "sin_contenido", hint: "Pega el correo (EML/HTML/texto) o facilita una URL." };
  const isHtml = /<[a-z][\s\S]*>/i.test(content);
  const html = /^\s*[A-Za-z-]+:/.test(content) && !isHtml ? "" : content;
  let raw = isHtml ? fromHtml(content, baseUrl) : [];
  if (!raw.length) raw = fromText(stripHeaders(content));
  const items = toItems(raw, baseUrl);
  return { ok: items.length > 0, reason: items.length ? null : "newsletter_sin_productos", data: { source: "newsletters", kind: "newsletter", count: items.length, items } };
}

const newsletters = {
  id: "newsletters",
  label: "Newsletters de tiendas",
  kind: "file",
  actions: {
    ping: async () => ({ ok: true, configured: true, reason: null, mode: "correo", note: "procesa EML/HTML/texto pegado o una URL publica (Gmail OAuth, fase posterior)" }),
    parse: parseNewsletter,
    browse: parseNewsletter,
    search: parseNewsletter
  }
};

module.exports = newsletters;
