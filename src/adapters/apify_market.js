/* Fuentes de PROVEEDOR/FABRICANTE vÃ­a Apify (una sola clave: APIFY_TOKEN).

   1688, Alibaba, Made-in-China, Google Shopping y busqueda por foto.
   Cada actor tiene su propio esquema de entrada (verificado en su ficha de
   Apify); la salida se mapea de forma tolerante. Todo resultado de 1688 /
   Alibaba / Made-in-China / foto es un CANDIDATO: hay que validar modelo y
   variante. Los precios que NO estan en EUR no se convierten (no se inventan
   cambios): se devuelven como texto (priceText) y price = null.
   Amazon no se rasca nunca (solo Keepa). */

const { config, apifyReady } = require("../config");
const apify = require("../lib/apify");
const gtinLib = require("../lib/gtin");
const { marketQuery } = require("../lib/translate");

function first(o, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = o && o[keys[i]];
    if (v != null && v !== "") return v;
  }
  return null;
}

function priceOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  if (typeof v === "object") return priceOf(first(v, ["min", "value", "amount", "price", "from"]));
  const m = String(v).replace(/\s/g, "").match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  return n > 0 ? n : null;
}

/* "10,000 wp" -> 10000 (cantidad minima de pedido). */
function moqOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const m = String(v).replace(/[,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function imageOf(o) {
  const v = first(o, ["image", "imageUrl", "image_url", "img", "mainImage", "thumbnail", "thumbnail_url", "thumbnailUrl", "product_image", "picUrl", "pic", "images"]);
  if (Array.isArray(v)) return String((v[0] && (v[0].url || v[0])) || "");
  return v ? String(v.url || v) : "";
}

function currencyOf(o) {
  return String(first(o, ["currency_code", "currency", "currencyCode"]) || "").trim();
}

/* Texto plano tolerante: los actores devuelven strings, arrays u objetos
   {name,value}. Se conserva lo que declaran, sin inventar atributos. */
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(" Â· ");
  if (typeof v === "object") return textOf(v.value != null ? v.value : (v.name || v.text || v.label || ""));
  return "";
}

function listOf(v) {
  const out = [];
  function add(x) {
    if (x == null) return;
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (typeof x === "object") {
      const k = x.name || x.key || x.label || x.spec || x.type;
      const val = x.value != null ? x.value : (x.val != null ? x.val : x.text);
      if (k && val != null) { out.push(String(k).trim() + ": " + textOf(val)); return; }
      /* Mapa plano {Color:"negro", Talla:"M"}: se conserva cada atributo. */
      const keys = Object.keys(x);
      const flat = keys.length > 0 && keys.every(function (k2) { return x[k2] == null || typeof x[k2] !== "object"; });
      if (flat) {
        keys.forEach(function (k2) {
          const t = textOf(x[k2]);
          if (t) out.push(String(k2).trim() + ": " + t);
        });
        return;
      }
      const t = textOf(x);
      if (t) out.push(t);
      return;
    }
    const t = textOf(x);
    if (t) out.push(t);
  }
  add(v);
  return out.filter(Boolean).slice(0, 30);
}

function isEur(cur, id) {
  if (id === "gshopping") return true; /* se pide country=es */
  return /â‚¬|eur/i.test(cur);
}

function toItem(o, id, label, candidate) {
  const url = String(first(o, ["product_url", "url", "link", "productUrl", "productLink", "detailUrl", "itemUrl", "href", "source_url"]) || "");
  const supplier = String(first(o, ["company_name", "shop_name", "supplier", "supplierName", "companyName", "sellerName", "seller_name", "seller", "merchant", "merchant_name", "merchantName", "store", "source", "source_name"]) || label);
  const cur = currencyOf(o);
  const lo = priceOf(first(o, ["priceNumeric", "min_price", "price_min", "price", "priceMin", "minPrice", "unitPrice", "salePrice", "extractedPrice", "extracted_price", "priceRange"]));
  const hi = priceOf(first(o, ["max_price", "price_max", "priceMax", "maxPrice"]));
  const eur = isEur(cur, id);
  let priceText = "";
  if (lo && !eur) {
    const sym = cur || "";
    priceText = (sym ? sym + " " : "") + lo + (hi && hi !== lo ? "â€“" + hi : "");
  }
  const moq = moqOf(first(o, ["moq", "min_order", "minOrder", "minimumOrder", "minOrderQuantity", "minOrderQuantity"]));
  const platform = String(first(o, ["provider", "platform", "marketplace"]) || id);
  /* Identidad y ficha completa: sin esto, una oferta china llega "desnuda" y
     el cotejo no puede comparar marca, modelo, color, medidas ni caracteristicas. */
  const brand = textOf(first(o, ["brand", "brandName", "brand_name"]));
  const model = textOf(first(o, ["model", "modelNumber", "model_number", "modelNo", "sku", "productCode", "articleNumber", "mpn"]));
  const eanRaw = String(first(o, ["ean", "gtin", "gtin13", "gtin12", "barcode", "upc"]) || "").replace(/\D/g, "");
  const ean = eanRaw.length >= 8 && eanRaw.length <= 14 ? eanRaw : "";
  const description = textOf(first(o, ["description", "product_description", "productDescription", "detail", "details", "shortDescription", "summary", "productDetails"])).slice(0, 1200);
  const specs = listOf(first(o, ["specifications", "specs", "attributes", "properties", "keyProperties", "keyFacts", "keyfacts", "parameters"]));
  const features = listOf(first(o, ["features", "featureList", "keyFeatures", "sellingPoints", "highlights"]));
  const color = textOf(first(o, ["color", "colour", "colorName", "color_name"]));
  const size = textOf(first(o, ["size", "dimensions", "dimension", "measurements", "productSize"]));
  const material = textOf(first(o, ["material", "materials"]));
  const weight = textOf(first(o, ["weight", "itemWeight", "item_weight", "productWeight"]));
  return {
    source: id,
    name: String(first(o, ["title", "product_name", "product_title", "name", "subject", "productName", "productTitle"]) || "").slice(0, 180),
    brand: brand,
    model: model,
    reference: model,
    ean: ean,
    description: description,
    specs: specs,
    features: features,
    color: color,
    size: size,
    material: material,
    weight: weight,
    price: eur ? lo : null,
    priceText: priceText,
    oldPrice: null,
    stock: null,
    available: true,
    limit: null,
    minOrder: moq,
    url: url,
    image: imageOf(o),
    supplier: supplier,
    isSupplier: true,
    candidate: Boolean(candidate),
    attrs: {
      currency: cur,
      platform: platform,
      factory: /manufactur|factory|fabric/i.test(String(first(o, ["business_type", "seller_type", "sellerType"]) || "")) || o.is_factory === true || o.isFactory === true,
      description: description,
      specs: specs,
      color: color,
      size: size,
      material: material,
      weight: weight,
      note: candidate ? "Candidato: validar modelo y variante antes de comprar." : ""
    },
    capturedAt: new Date().toISOString()
  };
}

/* Algunos actores devuelven una fila por consulta con los productos dentro
   (shoppingResults, products, results...). Se aplana para no perder tarjetas
   que si existen, sin inventar nada. */
function flatten(items, depth) {
  depth = depth || 0;
  const out = [];
  (Array.isArray(items) ? items : []).forEach(function (o) {
    if (!o || typeof o !== "object") return;
    const keys = ["shoppingResults", "productResults", "products", "results", "items", "data"];
    let nested = false;
    keys.forEach(function (k) {
      if (Array.isArray(o[k]) && depth < 2) {
        nested = true;
        flatten(o[k], depth + 1).forEach(function (x) { out.push(x); });
      }
    });
    /* La fila contenedora tambien puede ser un producto. */
    if (!nested || o.title || o.product_name || o.product_title || o.url || o.product_url) out.push(o);
  });
  return out;
}

function dedupe(items, max) {
  const seen = {};
  return items.filter(function (it) {
    if (!it.url || seen[it.url]) return false;
    seen[it.url] = 1;
    return true;
  }).slice(0, max);
}

function inStock(v) {
  const s = String(v || "").toLowerCase();
  return !/(outofstock|out_of_stock|soldout|sold_out|agotado|no disponible)/.test(s);
}

/* El actor de EAN devuelve una fila por codigo con TODAS las ofertas de tienda
   (store, price, shipping, direct link). Se convierten en resultados directos:
   no hace falta abrir cada ficha para verificar el EAN, porque el codigo ya es
   el de la fila. Se conservan envio, condicion, stock y enlace directo. */
function mapEanRows(rows, ean, max) {
  const want = gtinLib.normalizeAll([ean]);
  const out = [];
  const seen = {};
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row || typeof row !== "object") return;
    const got = gtinLib.normalize(row.gtin || row.ean || row.gtin13 || row.barcode || "");
    if (got && want.length && want.indexOf(got) === -1) return;
    const code = got || want[0] || "";
    const cur = String(row.currency || "").trim().toUpperCase();
    const eur = !cur || cur === "EUR";
    const base = {
      source: "gshopping_ean",
      name: String(row.title || "").slice(0, 180),
      brand: String(row.brand || ""),
      model: "", reference: "", ean: code,
      description: String(row.description || "").slice(0, 1200),
      specs: [], features: [], color: "", size: "", material: "", weight: "",
      image: String(row.imageUrl || row.thumbnail || ""),
      isSupplier: true,
      candidate: false,
      __via: "ean",
      __q: code,
      attrs: {
        currency: cur || "EUR",
        platform: "google_shopping_ean",
        gtin: code,
        gtinMatches: row.gtinMatches == null ? null : row.gtinMatches,
        offersCount: row.offersCount == null ? null : row.offersCount,
        offersAvailable: row.offersAvailable == null ? null : row.offersAvailable,
        productUrl: String(row.productUrl || ""),
        query: code
      }
    };
    const offers = Array.isArray(row.offers) ? row.offers : [];
    if (offers.length) {
      offers.forEach(function (o) {
        if (!o || typeof o !== "object") return;
        const price = priceOf(o.price != null ? o.price : o.totalPrice);
        const shipping = priceOf(o.shippingPrice != null ? o.shippingPrice : o.shipping);
        const total = priceOf(o.totalPrice);
        const store = String(o.store || o.sellerName || o.merchant || row.store || "");
        /* El actor trae el enlace directo de la tienda en `storeUrl`; `url`
           suele ser una redireccion de Google. Se prefiere el directo. */
        const directUrl = String(o.storeUrl || o.storeURL || o.store_url || o.retailerUrl || o.retailerURL ||
          o.merchantUrl || o.merchantURL || o.directUrl || o.directURL || "");
        const url = String(directUrl || o.url || o.link || o.productUrl || o.sellerReference ||
          row.storeUrl || row.storeURL || row.productUrl || "");
        const name = String(o.offerTitle || row.title || "").slice(0, 180);
        if (!name && !url) return;
        const k = url + "|" + (price == null ? "" : price.toFixed(2)) + "|" + store;
        if (seen[k]) return;
        seen[k] = 1;
        out.push(Object.assign({}, base, {
          name: name,
          price: eur ? price : null,
          priceText: !eur && price > 0 ? cur + " " + price : "",
          oldPrice: priceOf(o.oldPrice),
          shipping: shipping,
          stock: null,
          available: inStock(o.availability),
          url: url,
          supplier: store,
          attrs: Object.assign({}, base.attrs, {
            store: store,
            storeUrl: directUrl,
            shipping: shipping,
            totalPrice: total,
            condition: String(o.condition || ""),
            availability: String(o.availability || ""),
            offerId: String(o.offerId || o.offer_id || "")
          })
        }));
      });
      return;
    }
    const price = priceOf(row.price != null ? row.price : row.lowestOfferPrice);
    const url = String(row.productUrl || "");
    if (!row.title || (!url && !(price > 0))) return;
    const store = String(row.store || row.merchant || "");
    const k = url + "|" + (price == null ? "" : price.toFixed(2)) + "|" + store;
    if (seen[k]) return;
    seen[k] = 1;
    out.push(Object.assign({}, base, {
      price: eur ? price : null,
      priceText: !eur && price > 0 ? cur + " " + price : "",
      shipping: null,
      available: true,
      url: url,
      supplier: store
    }));
  });
  out.sort(function (a, b) {
    const pa = a.price > 0, pb = b.price > 0;
    if (pa && pb) return a.price - b.price;
    if (pa) return -1;
    if (pb) return 1;
    return 0;
  });
  return out.slice(0, max);
}

function queryOf(body) {
  const b = body || {};
  const q = String(b.query || "").trim();
  const parts = [b.brand, b.model, b.name].map(function (x) { return String(x == null ? "" : x).trim(); }).filter(Boolean);
  const text = parts.join(" ").trim();
  /* La cascada puede pasar el EAN como `query`; en un marketplace eso no
     encuentra el producto. Si hay marca/modelo/nombre, mandan ellos. */
  if (text && (!q || /^\d{8,14}$/.test(q))) return text;
  return String(q || text || "").trim();
}

/* Entradas EXACTAS por actor (esquema de su ficha en Apify). */
const BUILDERS = {
  /* datacach/1688-search-scraper (pay-per-event): keywords[] + maxItemsPerKeyword. */
  a1688: function (q, max) { return { keywords: [q], maxItemsPerKeyword: Math.min(Math.max(max, 3), 60), searchType: "pcmarket", proxyConfiguration: { useApifyProxy: true } }; },
  alibaba: function (q, max) { return { searchQueries: [q], maxProductsPerQuery: Math.min(max, 8), maxConcurrency: 3, proxyConfig: { useApifyProxy: true }, timeoutSecs: 80 }; },
  mic: function (q, max) { return { searchMode: "keyword", keyword: q, maxResults: max }; },
  aliexpress: function (q, max) { return { keyword: q, query: q, maxItems: max }; },
  shopping: function (q, max) {
    const list = (Array.isArray(q) ? q : [q]).filter(Boolean).slice(0, 3);
    return { queries: list, maxResults: Math.max(max, 20), country: String(config.apify.country || "es").toLowerCase(), language: "es", sortBy: "relevance" };
  }
};

function makeAdapter(def) {
  const id = def.id;
  function actorId() { return config.apify.actors[def.actor]; }

  async function search(body) {
    let q = queryOf(body);
    if (!q) return { ok: false, reason: "query_required" };
    /* Mercados chinos: sin marca y en su idioma (1688=zh, Alibaba/MIC=en). */
    if (def.lang) {
      if (/^\d{8,14}$/.test(q) && !(body && (body.name || body.model))) return { ok: false, reason: "sin_resultados", detail: "EAN no sirve en este mercado" };
      const adapted = await marketQuery(body && (body.name || body.model || body.brand) ? body : { name: q }, def.lang);
      if (adapted) q = adapted;
    }
    if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
    if (!actorId()) return { ok: false, reason: "actor_no_configurado" };
    const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 3), def.actor === "shopping" ? 60 : 30);
    /* Google Shopping no entiende bien un EAN suelto: se lanzan en la misma
       ejecucion el EAN, marca+modelo y el titulo corto. El actor etiqueta cada
       tarjeta con `query`, asi que el resultado se puede deduplicar. */
    let qs = [q];
    if (def.actor === "shopping") {
      const ean = String((body && body.ean) || "").replace(/\D/g, "");
      const bm = [body && body.brand, body && body.model].map(function (x) { return String(x || "").trim(); }).filter(Boolean).join(" ").trim();
      const shortTitle = String((body && body.name) || "").trim().split(/\s+/).slice(0, 10).join(" ");
      [ean.length >= 8 ? ean : "", bm, shortTitle].forEach(function (x) { if (x && qs.indexOf(x) === -1) qs.push(x); });
      qs = qs.slice(0, 3);
    }
    const op = (body && body.__op) || apify.newOp();
    const r = await apify.runActor(actorId(), BUILDERS[def.actor](qs.length > 1 ? qs : q, max), { op: op, estCost: def.estCost || 0.03, timeoutSec: def.timeoutSec || 40 });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    const items = dedupe(flatten(r.items).map(function (o) { return toItem(o, id, def.label, def.candidate); }), max);
    return {
      ok: items.length > 0,
      reason: items.length ? null : "sin_resultados",
      data: { source: id, query: q, cached: Boolean(r.cached), count: items.length, items: items }
    };
  }

  return {
    id: id,
    label: def.label,
    kind: "supplier_market",
    supplier: true,
    /* 1688/Alibaba/MIC construyen su consulta (sin marca, traducida) desde name: repetirlas con
       otra consulta cuesta dinero y devuelve lo mismo. La cascada las lanza una sola vez. */
    ownQuery: Boolean(def.lang),
    actions: {
      ping: async function () {
        const ok = apifyReady() && Boolean(actorId());
        return {
          ok: ok,
          configured: ok,
          reason: ok ? null : !apifyReady() ? "apify_sin_token" : "actor_no_configurado",
          mode: ok ? "apify:" + actorId() : "sin_clave",
          note: def.candidate ? "Resultados = candidatos: validar modelo y variante." : "Precios de comparacion en Google Shopping."
        };
      },
      search: search
    }
  };
}

/* Busqueda por foto (Amazon/Keepa -> 1688, Alibaba, AliExpress, Made-in-China...). */
async function searchByImage(body) {
  const b = body || {};
  const image = String(b.image || b.imageUrl || "").trim();
  if (!/^https?:\/\//i.test(image)) return { ok: false, reason: "imagen_requerida" };
  if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
  const actor = config.apify.actors.image;
  if (!actor) return { ok: false, reason: "actor_no_configurado" };
  const max = Math.min(Math.max(parseInt(b.max || "20", 10) || 20, 3), 40);
  const r = await apify.runActor(
    actor,
    { imageUrls: [image], targets: ["1688", "alibaba", "aliexpress", "made-in-china", "chinagoods", "yiwugo"], maxProducts: max },
    { estCost: 0.10, timeoutSec: 90, op: apify.newOp() }
  );
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  const items = dedupe(r.items.map(function (o) { return toItem(o, "foto", "BÃºsqueda por foto", true); }), max);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "sin_resultados",
    data: { source: "foto", cached: Boolean(r.cached), count: items.length, items: items }
  };
}

const a1688 = makeAdapter({ id: "a1688", actor: "a1688", label: "1688 (Apify)", lang: "zh", candidate: true, estCost: 0.03, timeoutSec: 90 });
const alibaba = makeAdapter({ id: "alibaba", actor: "alibaba", label: "Alibaba (Apify)", lang: "en", candidate: true, estCost: 0.03, timeoutSec: 100 });
const madeinchina = makeAdapter({ id: "madeinchina", actor: "mic", label: "Made-in-China (Apify)", lang: "en", candidate: true, estCost: 0.03, timeoutSec: 90 });
const gshopping = makeAdapter({ id: "gshopping", actor: "shopping", label: "Google Shopping (Apify)", candidate: false, estCost: 0.02, timeoutSec: 90 });
const aliexpressApify = makeAdapter({ id: "aliexpress_apify", actor: "aliexpress", label: "AliExpress texto (Apify)", candidate: true, estCost: 0.03 });

/* Google Shopping por EAN: usa un actor que resuelve el codigo de barras y
   devuelve todas las ofertas de tienda (precio, envio, stock y enlace directo).
   Evita depender de abrir fichas una a una y cubre tiendas que el buscador por
   palabra clave no muestra. El actor es configurable con APIFY_SHOPPING_EAN_ACTOR. */
const gshoppingEan = {
  id: "gshopping_ean",
  label: "Google Shopping · ofertas por EAN",
  kind: "supplier_market",
  supplier: true,
  ean: true,
  exactOnly: true,
  ownQuery: true,
  actions: {
    ping: async function () {
      const actor = config.apify.actors.shoppingEan;
      const ok = apifyReady() && Boolean(actor);
      return {
        ok: ok,
        configured: ok,
        reason: ok ? null : !apifyReady() ? "apify_sin_token" : "actor_no_configurado",
        mode: ok ? "apify:" + actor : "sin_clave",
        note: "Resuelve el EAN/GTIN y devuelve las ofertas de cada tienda con enlace directo."
      };
    },
    search: async function (body) {
      body = body || {};
      const ean = gtinLib.normalize(body.ean || (body.eans && body.eans[0]));
      if (!ean) return { ok: false, reason: "producto_sin_ean" };
      if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
      const actor = config.apify.actors.shoppingEan;
      if (!actor) return { ok: false, reason: "actor_no_configurado" };
      const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 3), 60);
      const op = body.__op || apify.newOp();
      const r = await apify.runActor(actor, {
        gtins: [ean],
        country: String(config.apify.country || "es").toLowerCase(),
        language: "es",
        includeOffers: true,
        includeDetails: false,
        /* Sin esto el actor devuelve redirecciones de Google en vez del
           enlace directo de cada tienda (`storeUrl`). */
        includeStoreLink: true,
        maxItems: max
      }, { op: op, estCost: 0.06, timeoutSec: 100 });
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
      const rows = Array.isArray(r.items) ? r.items : [];
      const items = mapEanRows(rows, ean, max);
      const errors = rows.map(function (row) { return row && (row.errorCode || row.error); }).filter(Boolean);
      const offers = rows.reduce(function (n, row) { return n + (row && Array.isArray(row.offers) ? row.offers.length : 0); }, 0);
      return {
        ok: items.length > 0,
        reason: items.length ? null : (errors[0] || "sin_resultados"),
        detail: errors.length ? String(errors[0]) : null,
        data: {
          source: "gshopping_ean", query: ean, count: items.length, items: items,
          evidence: { actor: actor, rows: rows.length, offers: offers, errors: errors.slice(0, 3) }
        }
      };
    }
  }
};

const foto = {
  id: "foto",
  label: "BÃºsqueda por foto (Apify)",
  kind: "supplier_market",
  /* No participa en searchSuppliers (necesita imagen, no texto): sin accion search. */
  actions: {
    ping: async function () {
      const ok = apifyReady() && Boolean(config.apify.actors.image);
      return { ok: ok, configured: ok, reason: ok ? null : "apify_sin_token", mode: ok ? "apify:" + config.apify.actors.image : "sin_clave", note: "Resultados = candidatos: validar modelo y variante." };
    },
    image: searchByImage
  }
};

module.exports = { a1688, alibaba, madeinchina, gshopping, gshoppingEan, aliexpressApify, foto, searchByImage, mapEanRows };

