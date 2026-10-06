const { feedReady, scrapingReady } = require("../config");
const { feedAction } = require("./feed");

const mapping = {
  name: ["name", "nombre", "title", "titulo", "producto"],
  brand: ["brand", "marca", "fabricante"],
  ean: ["upc", "ean", "gtin"],
  size: ["size", "tamaño", "tamano", "peso"],
  quantity: ["quantity", "cantidad", "unidades"],
  format: ["format", "formato"],
  variant: ["variant", "variante", "sabor"],
  price: ["price", "precio", "pvp"],
  stock: ["stock", "disponibilidad"],
  url: ["url", "link", "enlace"],
  image: ["image", "imagen", "foto"]
};

const iherb = {
  id: "iherb",
  label: "iHerb",
  kind: "scraping",
  actions: {
    ping: async () => ({
      ok: feedReady("iherb") || scrapingReady(),
      configured: feedReady("iherb") || scrapingReady(),
      reason: feedReady("iherb") ? null : scrapingReady() ? "provider_ready_no_feed" : "not_configured"
    }),
    feed: feedAction("iherb", mapping),
    search: async () => ({ ok: false, reason: "search_not_implemented", hint: "Configura FEED_IHERB (con UPC) o un proveedor de scraping." })
  }
};

module.exports = iherb;
