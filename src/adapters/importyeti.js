/* ImportYeti: lista de embarques (bill of lading) de EE. UU. Dice que fabrica
   extranjera esta detras de una marca/importador, con pais, direccion y numero
   de envios. No descubre por region: aporta la PRUEBA de quien fabrica.

   API oficial (data.importyeti.com), cabecera IYApiKey. Las busquedas son
   gratis; el listado cuesta 1 credito por cada 10 registros, asi que se pide
   poco y se cachea. Sin clave, el adaptador queda inerte (no rompe nada). */

const { config } = require("../config");
const { jsonFetch } = require("../lib/http");

const BASE = "https://data.importyeti.com";
const CACHE = new Map();
const CACHE_MS = 30 * 60 * 1000;

function apiKey() {
  return String((config.importyeti && config.importyeti.apiKey) || "").trim();
}

function slugify(q) {
  return String(q || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(manufacturer|manufacturers|supplier|suppliers|factory|wholesale|china|oem|odm)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function toItem(o) {
  const name = String((o && (o.supplier_name || o.name || o.company_name)) || "").trim();
  const link = String((o && (o.supplier_link || o.company_link || "")) || "");
  const url = /^https?:\/\//.test(link) ? link : (link ? "https://www.importyeti.com" + link : "");
  const shipments = Number(o && (o.matching_shipments || o.shipments || o.total_shipments)) || null;
  const spec = Number(o && (o.specialization || o.specialization_pct)) || null;
  const country = String((o && (o.supplier_country_code || o.country_code || o.country)) || "").trim();
  return {
    source: "importyeti",
    name: name.slice(0, 180),
    brand: "",
    model: "",
    reference: "",
    ean: "",
    description: "",
    specs: [],
    features: [],
    color: "",
    size: "",
    material: "",
    weight: "",
    price: null,
    priceText: "",
    oldPrice: null,
    stock: null,
    available: true,
    limit: null,
    minOrder: null,
    url: url,
    image: "",
    supplier: name,
    supplierType: "fabrica",
    factory: true,
    verifiedSupplier: true,
    moq: null,
    isSupplier: true,
    candidate: true,
    /* Evidencia de fabricacion: envios y especialidad en ESE producto. */
    evidence: {
      kind: "customs",
      shipments: shipments,
      specialization: spec,
      country: country
    },
    attrs: {
      platform: "importyeti",
      kind: "customs",
      factory: true,
      country: country,
      address: String((o && (o.supplier_address || o.address)) || "").slice(0, 160),
      shipments: shipments,
      specialization: spec,
      hs: String((o && (o.hs_code || o.hscode)) || "")
    }
  };
}

async function search(body) {
  const q = String((body && body.query) || "").trim();
  const limit = Math.min(Math.max(Number(body && body.max) || 10, 3), 20);
  if (!apiKey()) return { ok: false, reason: "importyeti_sin_clave", detail: "Falta IMPORTYETI_API_KEY" };
  const product = slugify(q);
  if (!product) return { ok: true, items: [], count: 0, reason: "consulta_sin_terminos" };
  const key = "p:" + product + ":" + limit;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const url = BASE + "/v1.0/product/" + encodeURIComponent(product) + "/suppliers?page_size=" + limit;
  const r = await jsonFetch(url, { headers: { IYApiKey: apiKey(), Accept: "application/json" } }, 25000);
  if (!r.ok) {
    return { ok: false, reason: r.status === 403 ? "sin_creditos" : "importyeti_error", detail: String(r.status || r.error || "") };
  }
  const rows = (r.data && (r.data.data || r.data.results || r.data.suppliers)) || [];
  const items = [];
  const seen = {};
  rows.forEach(function (o) {
    const it = toItem(o);
    if (!it.name) return;
    const k = it.name.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    items.push(it);
  });
  const value = {
    ok: items.length > 0,
    reason: items.length ? null : "sin_resultados",
    data: { source: "importyeti", product: product, count: items.length, items: items.slice(0, limit), credits: (r.data && r.data.requestCost) || 0 }
  };
  CACHE.set(key, { at: Date.now(), value: value });
  return value;
}

module.exports = {
  label: "ImportYeti (quién fabrica de verdad)",
  kind: "supplier_market",
  supplier: true,
  ownQuery: true,
  actions: {
    ping: async function () {
      const ok = Boolean(apiKey());
      return { ok: ok, configured: ok, reason: ok ? null : "importyeti_sin_clave", mode: ok ? "api:importyeti" : "sin_clave" };
    },
    search: search
  },
  _toItem: toItem,
  _slugify: slugify
};
