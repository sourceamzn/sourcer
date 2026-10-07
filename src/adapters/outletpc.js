const { feedReady, config } = require("../config");
const { feedAction } = require("./feed");
const { mapOutletProduct } = require("./mappers");
const { jsonFetch } = require("../lib/http");

const mapping = {
  name: ["name", "nombre", "title", "titulo", "producto", "descripcion"],
  brand: ["brand", "marca", "fabricante"],
  model: ["model", "modelo"],
  reference: ["reference", "referencia", "ref", "sku", "mpn"],
  ean: ["ean", "upc", "gtin", "codigo_de_barras"],
  price: ["price", "precio", "pvp", "precio_venta"],
  stock: ["stock", "disponibilidad", "unidades"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"]
};

const HOME = "https://outlet-pc.es/";
const API_VERSIONS = ["2024-10", "2024-07", "2024-04"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const QUERY = [
  "query Search($q:String!,$n:Int!){",
  "products(first:$n,query:$q){",
  "edges{node{",
  "id title handle vendor availableForSale totalInventory productType tags",
  "priceRange{minVariantPrice{amount currencyCode} maxVariantPrice{amount currencyCode}}",
  "featuredImage{url}",
  "variants(first:10){edges{node{id title sku barcode price{amount currencyCode} compareAtPrice{amount currencyCode} availableForSale}}}",
  "}}}}}"
].join("");

let cached = { token: null, version: null, at: 0 };
const CACHE_MS = 60 * 60 * 1000;

async function storefrontSession() {
  if (cached.token && cached.version && Date.now() - cached.at < CACHE_MS) return cached;
  const res = await jsonFetch(HOME, { method: "GET", headers: { "User-Agent": UA, Accept: "text/html" } }, 25000);
  const text = typeof res.data === "string" ? res.data : "";
  const token = (text.match(/storefrontAccessToken[^a-f0-9]*([a-f0-9]{20,})/i) || [])[1] || null;
  if (!token) return { error: "token_not_found" };
  cached = { token, version: API_VERSIONS[0], at: Date.now() };
  return cached;
}

async function graphql(token, version, query, variables) {
  return jsonFetch(
    "https://outlet-pc.es/api/" + version + "/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
        "User-Agent": UA,
        Accept: "application/json"
      },
      body: JSON.stringify({ query, variables })
    },
    25000
  );
}

async function search(body) {
  const query = String((body && (body.query || body.q)) || "").trim();
  if (!query) return { ok: false, reason: "query_required" };
  const max = Math.min(Math.max(parseInt((body && body.max) || "24", 10) || 24, 1), 60);
  const session = await storefrontSession();
  if (session.error) {
    return { ok: false, reason: session.error, hint: "No se pudo obtener el token publico de la tienda (¿cambio la web?)." };
  }
  let last = null;
  let usedVersion = session.version;
  for (const version of API_VERSIONS) {
    const res = await graphql(session.token, version, QUERY, { q: query, n: max });
    if (res.ok && res.data && res.data.data && res.data.data.products) {
      usedVersion = version;
      last = res;
      break;
    }
    if (res.ok && res.data && res.data.errors) {
      last = res;
      if (res.data.data && res.data.data.products) break;
      continue;
    }
    last = res;
  }
  const payload = last && last.data ? last.data : null;
  if (!payload || !payload.data || !payload.data.products) {
    return {
      ok: false,
      reason: "outletpc_request_failed",
      status: last ? last.status : 0,
      error: last ? last.error : null,
      hint: "La tienda no devolvio productos; revisa la consulta."
    };
  }
  const nodes = (payload.data.products.edges || []).map(function (e) {
    return e.node;
  });
  const items = nodes.map(mapOutletProduct);
  return {
    ok: true,
    data: { source: "outletpc", query, count: items.length, apiVersion: usedVersion, currency: "EUR", items }
  };
}

const outletpc = {
  id: "outletpc",
  label: "Outlet PC",
  kind: "scraping",
  actions: {
    ping: async () => {
      const session = await storefrontSession();
      return {
        ok: Boolean(session.token) || feedReady("outletpc"),
        configured: Boolean(session.token) || feedReady("outletpc"),
        reason: session.token ? null : "storefront_token_unavailable",
        mode: session.token ? "tienda_shopify" : "feed",
        note: session.token ? "busqueda real via Storefront API (sin claves)" : null
      };
    },
    feed: feedAction("outletpc", mapping),
    search
  }
};

module.exports = outletpc;
