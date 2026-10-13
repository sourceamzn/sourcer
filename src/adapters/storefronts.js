/* Adaptador de storefronts FBA: busqueda inversa (del PDF, "de ASIN a
   proveedor").

   Tres vias:
   - `discover`: busqueda abierta. Dada una categoria o palabra clave (sin saber
                 aun el vendedor ni el ASIN) descubre vendedores FBA leyendo la
                 busqueda de Amazon y extrayendo los storefronts (`sp?seller=`).
   - `seller`  : dado un vendedor FBA (sellerId o URL de storefront), devuelve su
                 catalogo de ASINs leyendo la pagina publica del vendedor.
   - `reverse` : dado un ASIN, devuelve que vendedores lo ofrecen (SP-API cuando
                 hay credenciales) y los candidatos de compra en el catalogo de
                 proveedores del PDF (busqueda por ASIN/marca).

   Regla del PDF que respeta: sin listing/ASIN previo en Amazon no hay
   oportunidad; este adaptador nunca crea ASIN, solo lee los existentes. */

const { amazonReady } = require("../config");
const spapi = require("../lib/spapi");
const parse = require("../lib/parse");
const { fetchHtml } = require("./profile");
const { PROFILES } = require("./sources/catalog");

const MARKET = "https://www.amazon.es";

function asinFrom(text) {
  const m = String(text || "").match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (m) return m[1].toUpperCase();
  return "";
}

function sellerUrl(body) {
  if (body && body.url) return String(body.url);
  const id = body && (body.sellerId || body.seller || body.merchant);
  if (!id) return "";
  return MARKET + "/sp?seller=" + encodeURIComponent(String(id).trim());
}

function itemsFromStorefront(html, baseUrl, seller) {
  const items = [];
  const seen = {};
  const re = /data-asin=["']([A-Z0-9]{10})["'][^>]*>([\s\S]{0,1200}?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const asin = m[1].toUpperCase();
    if (seen[asin]) continue;
    seen[asin] = true;
    const block = m[2];
    const img = (block.match(/<img\b([^>]*)>/i) || [])[1];
    const imgSrc = img ? parse.attr(img, "src") : "";
    const title = parse.stripTags((block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "") ||
      parse.stripTags((block.match(/<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "");
    const priceMatch = block.match(/(?:€|EUR)\s*([\d.,]+)|([\d.,]+)\s*(?:€|EUR)/i);
    items.push({
      asin,
      name: title || "ASIN " + asin,
      url: MARKET + "/dp/" + asin,
      image: imgSrc ? parse.absUrl(baseUrl, imgSrc) : "",
      price: priceMatch ? parse.parsePrice(priceMatch[1] || priceMatch[2]) : null,
      currency: "EUR",
      attrs: { seller: seller || "", asin }
    });
  }
  if (!items.length) {
    const seen2 = {};
    const hrefRe = /href=["']([^"']*\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^"']*)["']/gi;
    while ((m = hrefRe.exec(html))) {
      const asin = asinFrom(m[1]);
      if (!asin || seen2[asin]) continue;
      seen2[asin] = true;
      items.push({ asin, name: "ASIN " + asin, url: MARKET + "/dp/" + asin, image: "", price: null, currency: "EUR", attrs: { seller: seller || "", asin } });
    }
  }
  return items;
}

function sellersFromOffers(offers) {
  const out = [];
  const data = offers && offers.data ? offers.data : null;
  const payload = data && data.payload ? data.payload : data;
  const arr = (payload && (payload.Offers || payload.offers)) || [];
  arr.forEach(function (o) {
    const sellerId = o.SellerId || o.sellerId || "";
    out.push({
      sellerId,
      storefront: sellerId ? MARKET + "/sp?seller=" + sellerId : "",
      fba: Boolean(o.IsFulfilledByAmazon != null ? o.IsFulfilledByAmazon : o.isFba),
      price: o.ListingPrice ? parse.parsePrice(o.ListingPrice.Amount) : null,
      shipping: o.Shipping ? parse.parsePrice(o.Shipping.Amount) : null,
      condition: o.SubCondition || o.ItemCondition || ""
    });
  });
  return out;
}

function sourceCandidates(query) {
  const q = String(query || "").trim();
  return (PROFILES || [])
    .filter(function (p) { return !p.requiresAuth; })
    .map(function (p) {
      const base = (p.home || "").replace(/\/+$/, "");
      const search = p.search && typeof p.search.url === "function" ? p.search.url(q) : base + "?s=" + encodeURIComponent(q);
      return { id: p.id, label: p.label, search: search };
    });
}

function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/* Descubrimiento abierto: de la pagina de busqueda de Amazon se extraen los
   storefronts (`sp?seller=`) para saber que vendedores ofrecen "algo" de esa
   categoria/palabra clave, sin partir de un ASIN ni de un vendedor conocidos. */
function sellerIdsFromHtml(html) {
  const out = [], seen = {};
  [/[?&]seller=([A-Z0-9]{6,})/gi, /[?&]merchantId=([A-Z0-9]{6,})/gi].forEach(function (re) {
    let m;
    while ((m = re.exec(html))) {
      const id = m[1].toUpperCase();
      if (seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
  });
  return out;
}

const storefronts = {
  id: "storefronts",
  label: "Storefronts FBA (listas de vendedores)",
  kind: "reverse",
  actions: {
    ping: async () => ({
      ok: true,
      configured: true,
      reason: null,
      spapi: amazonReady(),
      mode: amazonReady() ? "spapi+lectura_web" : "lectura_web",
      note: amazonReady()
        ? "vendedores por SP-API y catalogo del storefront por lectura web"
        : "sin SP-API: catalogo del storefront por lectura web; vendedores de un ASIN limitados"
    }),
    discover: async (body) => {
      const query = String((body && (body.query || body.q)) || "").trim();
      const limit = clampInt(body && body.limit, 10, 1, 20);
      if (!query) {
        return { ok: false, reason: "query_required", hint: "Escribe una categoria o palabra clave para descubrir vendedores." };
      }
      const targets = [
        MARKET + "/s?k=" + encodeURIComponent(query) + "&i=merchant-items",
        MARKET + "/s?k=" + encodeURIComponent(query)
      ];
      const ids = [], seen = {}, notes = [];
      let via = "";
      for (const url of targets) {
        const fetched = await fetchHtml(url);
        if (!fetched.ok) { notes.push(fetched.reason || "fetch_failed"); continue; }
        via = fetched.via || via;
        sellerIdsFromHtml(fetched.html).forEach(function (id) {
          if (!seen[id]) { seen[id] = true; ids.push(id); }
        });
        if (ids.length >= limit) break;
      }
      const sellers = ids.slice(0, limit).map(function (id) {
        return { sellerId: id, storefront: MARKET + "/sp?seller=" + id };
      });
      return {
        ok: sellers.length > 0,
        reason: sellers.length ? null : (notes[0] || "sin_vendedores_legibles"),
        data: {
          source: "storefronts",
          kind: "discover",
          query,
          via,
          count: sellers.length,
          sellers,
          note: sellers.length
            ? "Lee y analiza las listas con la misma herramienta (ROI, beneficio bruto/neto, rotacion)."
            : "Amazon no devolvio listas de vendedores para esa busqueda (bloqueo de lectura o sin resultados)."
        }
      };
    },
    seller: async (body) => {
      const url = sellerUrl(body || {});
      if (!url) return { ok: false, reason: "seller_required", hint: "Facilita sellerId o la URL del storefront." };
      const fetched = await fetchHtml(url);
      if (!fetched.ok) return { ok: false, reason: fetched.reason, status: fetched.status, url };
      const items = itemsFromStorefront(fetched.html, url, (body && (body.sellerId || body.seller)) || "");
      return { ok: items.length > 0, reason: items.length ? null : "storefront_sin_resultados", data: { source: "storefronts", kind: "seller", url, via: fetched.via, count: items.length, items } };
    },
    browse: async (body) => storefronts.actions.seller(body || {}),
    reverse: async (body) => {
      const asin = String((body && (body.asin || body.ASIN)) || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) return { ok: false, reason: "asin_required" };
      let offers = { ok: false, reason: "spapi_unavailable" };
      if (amazonReady()) offers = await spapi.getItemOffers(asin);
      const sellers = sellersFromOffers(offers);
      const candidates = sourceCandidates(asin);
      return {
        ok: true,
        data: {
          source: "storefronts",
          kind: "reverse",
          asin,
          amazonUrl: MARKET + "/dp/" + asin,
          offersOk: Boolean(offers && offers.ok),
          sellers,
          sources: candidates
        }
      };
    }
  }
};

module.exports = storefronts;
