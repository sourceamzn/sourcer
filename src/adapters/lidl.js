const { feedReady, scrapingReady } = require("../config");
const { feedAction } = require("./feed");

const mapping = {
  name: ["name", "nombre", "title", "titulo", "producto", "descripcion"],
  brand: ["brand", "marca", "fabricante"],
  model: ["model", "modelo"],
  reference: ["reference", "referencia", "ref", "sku", "mpn"],
  ean: ["ean", "upc", "gtin"],
  price: ["price", "precio", "pvp", "precio_venta"],
  stock: ["stock", "disponibilidad", "unidades"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"],
  measures: ["medidas", "measures", "tamaño", "dimensiones"],
  color: ["color"],
  pack: ["pack", "unidades", "cantidad"]
};

const lidl = {
  id: "lidl",
  label: "Lidl",
  kind: "scraping",
  actions: {
    ping: async () => ({
      ok: feedReady("lidl") || scrapingReady(),
      configured: feedReady("lidl") || scrapingReady(),
      reason: feedReady("lidl") ? null : scrapingReady() ? "provider_ready_no_feed" : "not_configured"
    }),
    feed: feedAction("lidl", mapping),
    search: async () => ({ ok: false, reason: "search_not_implemented", hint: "Configura FEED_LIDL o un proveedor de scraping." })
  }
};

module.exports = lidl;
