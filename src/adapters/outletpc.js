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

const FIELDS = [
  "id title handle vendor availableForSale totalInventory productType tags",
  "priceRange{minVariantPrice{amount currencyCode} maxVariantPrice{amount currencyCode}}",
  "compareAtPriceRange{minVariantPrice{amount currencyCode}}",
  "featuredImage{url}",
  "variants(first:10){edges{node{id title sku barcode price{amount currencyCode} compareAtPrice{amount currencyCode} availableForSale}}}"
].join(" ");

const QUERY = ["query Search($q:String!,$n:Int!){", "products(first:$n,query:$q){", "edges{node{", FIELDS, "}", "}", "}"].join(" ");

/* Barrido sin palabra clave: catalogo por novedades (outlet = descuentos continuos). */
const BROWSE_QUERY = [
  "query Browse($n:Int!,$q:String,$after:String){",
  "products(first:$n,sortKey:CREATED_AT,reverse:true,query:$q,after:$after){",
  "pageInfo{hasNextPage endCursor}",
  "edges{node{", FIELDS, "}",
  "}",
  "}",
  "}"
].join(" ");

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

function normTokens(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(function (t) { return t.length > 2; });
}

/* Filtro local: cuantos tokens utiles de la busqueda aparecen en el producto.
   Evita depender de la sintaxis de busqueda del Storefront cuando esta falla. */
function scoreNode(node, term) {
  const hay = normTokens((node.title || "") + " " + (node.vendor || "") + " " + (node.productType || ""));
  const tokens = normTokens(term);
  if (!tokens.length) return 0;
  let hits = 0;
  tokens.forEach(function (t) {
    if (hay.some(function (w) { return w === t || w.indexOf(t) === 0 || t.indexOf(w) === 0; })) hits++;
  });
  return hits / tokens.length;
}

async function fetchProducts(token, version, query, variables) {
  const res = await graphql(token, version, query, variables);
  if (res.ok && res.data && res.data.data && res.data.data.products) return res;
  if (res.ok && res.data && res.data.errors && res.data.data && res.data.data.products) return res;
  return res;
}

/* Plan B de busqueda: si la consulta por palabra clave no devuelve productos,
   se barre el catalogo disponible y se filtra en local por similitud de titulo. */
async function searchFallback(token, max, query) {
  let last = null;
  for (const version of API_VERSIONS) {
    const res = await fetchProducts(token, version, BROWSE_QUERY, { q: "available_for_sale:true", n: Math.min(Math.max(max * 3, 60), 250), after: null });
    const payload = res && res.data ? res.data : null;
    if (payload && payload.data && payload.data.products) {
      const nodes = (payload.data.products.edges || []).map(function (e) { return e.node; });
      const scored = nodes
        .map(function (node) { return { node: node, s: scoreNode(node, query) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, max)
        .map(function (x) { return x.node; });
      const items = scored.map(mapOutletProduct);
      items.forEach(function (it) {
        if (it.oldPrice && it.price && it.oldPrice > it.price) {
          it.discountPct = Math.round((1 - it.price / it.oldPrice) * 100);
        }
      });
      return { ok: true, data: { source: "outletpc", query, kind: "search", count: items.length, apiVersion: version, currency: "EUR", via: "fallback_local", items } };
    }
    last = res;
  }
  return {
    ok: false,
    reason: "outletpc_request_failed",
    status: last ? last.status : 0,
    error: last ? last.error : null,
    hint: "La tienda no devolvio productos; revisa la consulta."
  };
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
    /* La busqueda nativa fallo: se resuelve con barrido + filtro local. */
    return searchFallback(session.token, max, query);
  }
  const nodes = (payload.data.products.edges || []).map(function (e) {
    return e.node;
  });
  let items = nodes.map(mapOutletProduct);
  const native = items.length;
  if (!native) {
    /* Sin resultados nativos: se intenta el filtro local antes de rendirse. */
    const fb = await searchFallback(session.token, max, query);
    if (fb.ok && fb.data.items.length) return fb;
  }
  if (native) {
    items.forEach(function (it) {
      if (it.oldPrice && it.price && it.oldPrice > it.price) {
        it.discountPct = Math.round((1 - it.price / it.oldPrice) * 100);
      }
    });
  }
  return {
    ok: true,
    data: { source: "outletpc", query, kind: "search", count: items.length, apiVersion: usedVersion, currency: "EUR", via: native ? "storefront" : "storefront_vacio", items }
  };
}

/* Barrido del catalogo sin palabra clave (paso 1 del proceso: altas nuevas y bajadas). */
async function browse(body) {
  body = body || {};
  const max = Math.min(Math.max(parseInt(body.max || "24", 10) || 24, 1), 60);
  const after = body.after ? String(body.after) : null;
  const onlyOffers = body.offers !== false;
  const filter = String(body.filter || "available_for_sale:true");
  const session = await storefrontSession();
  if (session.error) {
    return { ok: false, reason: session.error, hint: "No se pudo obtener el token publico de la tienda (¿cambio la web?)." };
  }
  let last = null;
  let usedVersion = session.version;
  for (const version of API_VERSIONS) {
    const res = await graphql(session.token, version, BROWSE_QUERY, { q: filter, n: max, after });
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
  const conn = payload.data.products;
  const nodes = (conn.edges || []).map(function (e) {
    return e.node;
  });
  let items = nodes.map(mapOutletProduct);
  items.forEach(function (it) {
    if (it.oldPrice && it.price && it.oldPrice > it.price) {
      it.discountPct = Math.round((1 - it.price / it.oldPrice) * 100);
    }
  });
  if (onlyOffers) items = items.filter(function (it) {
    return it.discountPct != null || it.oldPrice;
  });
  return {
    ok: true,
    data: {
      source: "outletpc",
      kind: "browse",
      count: items.length,
      apiVersion: usedVersion,
      currency: "EUR",
      hasNextPage: Boolean(conn.pageInfo && conn.pageInfo.hasNextPage),
      endCursor: (conn.pageInfo && conn.pageInfo.endCursor) || null,
      items
    }
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
    search,
    browse
  }
};

module.exports = outletpc;
