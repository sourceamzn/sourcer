const { feedReady, scrapingReady } = require("../config");
const { feedAction } = require("./feed");

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

const outletpc = {
  id: "outletpc",
  label: "Outlet PC",
  kind: "scraping",
  actions: {
    ping: async () => ({
      ok: feedReady("outletpc") || scrapingReady(),
      configured: feedReady("outletpc") || scrapingReady(),
      reason: feedReady("outletpc") ? null : scrapingReady() ? "provider_ready_no_feed" : "not_configured"
    }),
    feed: feedAction("outletpc", mapping),
    search: async () => ({ ok: false, reason: "search_not_implemented", hint: "Configura FEED_OUTLETPC o un proveedor de scraping." })
  }
};

module.exports = outletpc;
