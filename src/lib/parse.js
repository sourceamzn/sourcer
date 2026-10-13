/* Parser compartido de HTML de tienda: JSON-LD (schema.org), microdata y
   heuristica de anclas. Lo usan todos los adaptadores "de perfil" (outlets,
   mayoristas, fabricantes) para devolver el mismo contrato de producto. */

const ENTITIES = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  "#39": "'",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ccedil: "ç",
  euro: "€",
  ndash: "–",
  mdash: "—"
};

function decodeEntities(value) {
  return String(value == null ? "" : value).replace(/&(#?[a-zA-Z0-9]+);/g, function (m, code) {
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

function stripTags(value) {
  return decodeEntities(String(value == null ? "" : value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value == null ? "" : value));
}

function absUrl(base, href) {
  const raw = stripTags(href);
  if (!raw) return "";
  if (isHttpUrl(raw)) return raw;
  try {
    return new URL(raw, base).href;
  } catch (e) {
    return raw;
  }
}

function digits(value) {
  return String(value == null ? "" : value).replace(/[^0-9]/g, "");
}

/* EAN-8/13/14 o UPC (12) con posible separador. Devuelve el primero valido. */
function detectEan() {
  for (let i = 0; i < arguments.length; i++) {
    const d = digits(arguments[i]);
    if (d.length === 8 || d.length === 12 || d.length === 13 || d.length === 14) return d;
  }
  return "";
}

function parsePrice(value) {
  if (value == null || value === "") return null;
  let s = String(value).replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.indexOf(",") !== -1) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function attr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i");
  const m = String(tag).match(re);
  if (!m) return "";
  return decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || "");
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let json;
    try {
      json = JSON.parse(m[1].trim());
    } catch (e) {
      continue;
    }
    const queue = Array.isArray(json) ? json.slice() : [json];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node["@graph"])) queue.push.apply(queue, node["@graph"]);
      if (Array.isArray(node.itemListElement)) queue.push.apply(queue, node.itemListElement);
      out.push(node);
    }
  }
  return out;
}

function brandName(brand) {
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  if (Array.isArray(brand)) return brandName(brand[0]);
  return brand.name || "";
}

function imageUrl(image) {
  if (!image) return "";
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return imageUrl(image[0]);
  return image.url || image.contentUrl || "";
}

function offerPrice(offers) {
  if (!offers) return { price: null, currency: "" };
  const list = Array.isArray(offers) ? offers : [offers];
  for (let i = 0; i < list.length; i++) {
    const o = list[i] && typeof list[i] === "object" ? list[i] : {};
    const p = parsePrice(o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : o.highPrice);
    if (p != null) return { price: p, currency: o.priceCurrency || "" };
  }
  return { price: null, currency: "" };
}

function productNode(node, baseUrl) {
  if (!node || typeof node !== "object") return null;
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.indexOf("Product") === -1) return null;
  const name = stripTags(node.name || node.title || "");
  if (!name) return null;
  const off = offerPrice(node.offers);
  return {
    name,
    url: absUrl(baseUrl, node.url || node["@id"] || ""),
    image: absUrl(baseUrl, imageUrl(node.image)),
    brand: brandName(node.brand),
    sku: node.sku || node.mpn || "",
    ean: detectEan(node.gtin13, node.gtin, node.gtin12, node.ean, node.upc, node.sku),
    price: off.price,
    currency: off.currency,
    description: stripTags(node.description || "").slice(0, 400)
  };
}

function productsFromJsonLd(html, baseUrl) {
  const items = [];
  const seen = {};
  jsonLdBlocks(html).forEach(function (node) {
    const p = productNode(node, baseUrl);
    if (!p) return;
    const key = p.ean || p.url || p.name;
    if (seen[key]) return;
    seen[key] = true;
    items.push(p);
  });
  return items;
}

function productsFromMicrodata(html, baseUrl) {
  const items = [];
  const re = /<[^>]+itemtype=["'][^"']*schema\.org\/(?:Product|ProductGroup)["'][^>]*>([\s\S]*?)(?=<[^>]+itemtype=["'][^"']*schema\.org\/|$)/gi;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const itemprop = function (name) {
      const re2 = new RegExp('itemprop=["\']' + name + '["\'][^>]*>(?:([^<]*))', "i");
      const mm = block.match(re2);
      if (mm) return stripTags(mm[1]);
      const re3 = new RegExp('itemprop=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', "i");
      const m3 = block.match(re3);
      return m3 ? m3[1] : "";
    };
    const name = itemprop("name");
    if (!name) continue;
    items.push({
      name,
      url: absUrl(baseUrl, itemprop("url")),
      image: absUrl(baseUrl, itemprop("image")),
      brand: itemprop("brand"),
      sku: itemprop("sku") || itemprop("mpn"),
      ean: detectEan(itemprop("gtin13"), itemprop("gtin"), itemprop("gtin12")),
      price: parsePrice(itemprop("price")),
      currency: itemprop("priceCurrency"),
      description: ""
    });
  }
  return items;
}

/* Heuristica de anclas: enlaces con pinta de ficha de producto y un precio
   cercano. Es el ultimo recurso cuando la web no publica JSON-LD. */
function genericProducts(html, baseUrl, opts) {
  opts = opts || {};
  const pattern = opts.linkPattern || /\/(product|producto|productos|p|pr|item|articulo|shop|coleccion|tienda|es\/[^/]+\/)[^"'\s]*/i;
  const items = [];
  const seen = {};
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = attr(m[1], "href");
    if (!href || !pattern.test(href)) continue;
    const url = absUrl(baseUrl, href);
    if (!url || url === baseUrl) continue;
    const inner = m[2];
    const img = (inner.match(/<img\b([^>]*)>/i) || [])[1];
    const imgSrc = img ? attr(img, "src") || attr(img, "data-src") || attr(img, "data-lazy") : "";
    const title = attr(m[1], "title") || (img ? attr(img, "alt") : "") || stripTags(inner);
    const name = stripTags(title).slice(0, 180);
    if (!name || name.length < 4) continue;
    const tail = html.slice(href == null ? m.index : m.index, m.index + 900);
    const priceMatch = tail.match(/(?:€|EUR)\s*([\d.,]+)|([\d.,]+)\s*(?:€|EUR)/i);
    const price = priceMatch ? parsePrice(priceMatch[1] || priceMatch[2]) : null;
    const key = (url.split(/[?#]/)[0]) || name;
    if (seen[key]) continue;
    seen[key] = true;
    items.push({
      name,
      url,
      image: imgSrc ? absUrl(baseUrl, imgSrc) : "",
      brand: "",
      sku: "",
      ean: "",
      price,
      currency: "EUR",
      description: ""
    });
  }
  return items;
}

function parseProducts(html, baseUrl, platform) {
  let items = [];
  if (platform !== "html") {
    items = productsFromJsonLd(html, baseUrl);
    if (!items.length) items = productsFromMicrodata(html, baseUrl);
  }
  if (!items.length) items = genericProducts(html, baseUrl, platform && platform.options);
  return items;
}

module.exports = {
  decodeEntities,
  stripTags,
  isHttpUrl,
  absUrl,
  digits,
  detectEan,
  parsePrice,
  attr,
  jsonLdBlocks,
  productsFromJsonLd,
  productsFromMicrodata,
  genericProducts,
  parseProducts
};
