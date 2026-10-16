/* Fuentes de PROVEEDOR/FABRICANTE vía Apify (una sola clave: APIFY_TOKEN).

   1688, Alibaba, Made-in-China, Google Shopping y busqueda por foto.
   Los actores son de la comunidad y su esquema de entrada/salida puede variar:
   el mapeo es tolerante (varios nombres de campo) y los IDs son configurables
   (APIFY_*_ACTOR). Todo resultado de 1688/Alibaba/Made-in-China/foto es un
   CANDIDATO: hay que validar modelo y variante, nunca es coincidencia exacta.
   Amazon no se rasca nunca (solo Keepa). */

const { config, apifyReady } = require("../config");
const apify = require("../lib/apify");

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

function imageOf(o) {
  const v = first(o, ["image", "imageUrl", "img", "mainImage", "thumbnail", "picUrl", "pic", "images"]);
  if (Array.isArray(v)) return String(v[0] && (v[0].url || v[0]) || "");
  return v ? String(v.url || v) : "";
}

function toItem(o, id, label, candidate) {
  const url = String(first(o, ["url", "link", "productUrl", "detailUrl", "itemUrl", "href"]) || "");
  const supplier = String(first(o, ["supplier", "supplierName", "companyName", "shopName", "seller", "store", "merchant", "source"]) || label);
  const cur = String(first(o, ["currency", "currencyCode"]) || "");
  const moq = first(o, ["moq", "minOrder", "minimumOrder", "minOrderQuantity"]);
  return {
    source: id,
    name: String(first(o, ["title", "name", "subject", "productName", "productTitle"]) || "").slice(0, 180),
    brand: "",
    model: "",
    reference: "",
    ean: "",
    price: priceOf(first(o, ["price", "priceMin", "minPrice", "unitPrice", "salePrice", "extractedPrice", "priceRange"])),
    oldPrice: null,
    stock: null,
    available: true,
    limit: null,
    minOrder: moq != null ? priceOf(moq) : null,
    url: url,
    image: imageOf(o),
    supplier: supplier,
    isSupplier: true,
    candidate: Boolean(candidate),
    attrs: {
      currency: cur,
      platform: id,
      note: candidate ? "Candidato: validar modelo y variante antes de comprar." : ""
    },
    capturedAt: new Date().toISOString()
  };
}

function dedupe(items, max) {
  const seen = {};
  return items.filter(function (it) {
    if (!it.url || seen[it.url]) return false;
    seen[it.url] = 1;
    return true;
  }).slice(0, max);
}

function queryOf(body) {
  const b = body || {};
  const parts = [b.brand, b.model, b.name].map(function (x) { return String(x == null ? "" : x).trim(); }).filter(Boolean);
  return String(b.query || parts.join(" ") || "").trim();
}

/* Entradas por actor: se envian varias claves habituales; los actores ignoran
   las que no conocen. */
const BUILDERS = {
  a1688: function (q, max) { return { keyword: q, keywords: [q], query: q, searchQuery: q, maxItems: max, maxResults: max, limit: max }; },
  alibaba: function (q, max) { return { keyword: q, keywords: [q], query: q, searchQuery: q, searchTerms: [q], maxItems: max, maxResults: max, limit: max }; },
  mic: function (q, max) { return { keyword: q, keywords: [q], query: q, searchQuery: q, searchTerms: [q], maxItems: max, maxResults: max, limit: max }; },
  aliexpress: function (q, max) { return { keyword: q, query: q, searchQuery: q, maxItems: max, maxResults: max, limit: max }; },
  shopping: function (q, max) {
    return { queries: [q], query: q, searchQuery: q, country: config.apify.country, countryCode: config.apify.country, languageCode: "es", maxItems: max, maxResults: max, limit: max };
  }
};

function makeAdapter(def) {
  const id = def.id;
  function actorId() { return config.apify.actors[def.actor]; }

  async function search(body) {
    const q = queryOf(body);
    if (!q) return { ok: false, reason: "query_required" };
    if (!apifyReady()) return { ok: false, reason: "apify_sin_token" };
    if (!actorId()) return { ok: false, reason: "actor_no_configurado" };
    const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 3), 30);
    const op = (body && body.__op) || apify.newOp();
    const r = await apify.runActor(actorId(), BUILDERS[def.actor](q, max), { op: op, estCost: def.estCost || 0.03, limit: max });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    const items = dedupe(r.items.map(function (o) { return toItem(o, id, def.label, def.candidate); }), max);
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
    { imageUrl: image, imageUrls: [image], image: image, startUrls: [{ url: image }], maxItems: max, maxResults: max, limit: max },
    { estCost: 0.10, limit: max, op: apify.newOp() }
  );
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
  const items = dedupe(r.items.map(function (o) {
    const it = toItem(o, "foto", "Búsqueda por foto", true);
    const plat = first(o, ["platform", "marketplace", "site", "source"]);
    if (plat) it.attrs.platform = String(plat);
    return it;
  }), max);
  return {
    ok: items.length > 0,
    reason: items.length ? null : "sin_resultados",
    data: { source: "foto", cached: Boolean(r.cached), count: items.length, items: items }
  };
}

const a1688 = makeAdapter({ id: "a1688", actor: "a1688", label: "1688 (Apify)", candidate: true, estCost: 0.03 });
const alibaba = makeAdapter({ id: "alibaba", actor: "alibaba", label: "Alibaba (Apify)", candidate: true, estCost: 0.03 });
const madeinchina = makeAdapter({ id: "madeinchina", actor: "mic", label: "Made-in-China (Apify)", candidate: true, estCost: 0.03 });
const gshopping = makeAdapter({ id: "gshopping", actor: "shopping", label: "Google Shopping (Apify)", candidate: false, estCost: 0.02 });
const aliexpressApify = makeAdapter({ id: "aliexpress_apify", actor: "aliexpress", label: "AliExpress texto (Apify)", candidate: true, estCost: 0.03 });

const foto = {
  id: "foto",
  label: "Búsqueda por foto (Apify)",
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

module.exports = { a1688, alibaba, madeinchina, gshopping, aliexpressApify, foto, searchByImage };
