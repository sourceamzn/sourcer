/* Adaptador del panel "Top 20 · Mas vendidos amazon.es".

   Expone tres acciones al frontend via POST /sourcing/top20/{accion}:
   - categories: categorias raiz de amazon.es (Keepa Category Lookup, category=0).
   - list:       top de una categoria (Keepa Best Sellers + productos con stats:
                 precio, BSR y ventas/mes), servido de cache con sello de fecha.
   - refresh:    fuerza la reconstruccion (manual); tambien lo usa el planificador.

   Todo por API (Keepa, domain 9). Nunca scraping de Amazon. No crea ASIN ni
   listings: es una guia de referencia, no una fuente de proveedor. */

const top20 = require("../lib/top20");
const { keepaReady } = require("../config");

const adapter = {
  id: "top20",
  label: "Top 20 · Mas vendidos amazon.es",
  kind: "amazon",
  actions: {
    ping: async () => ({
      ok: true,
      keepa: keepaReady(),
      reason: keepaReady() ? null : "keepa_not_configured",
      note: keepaReady()
        ? "Top 20 por categoria de Amazon.es con Keepa Best Sellers (precio, BSR y ventas/mes)."
        : "Configura KEEPA_API_KEY para obtener los mas vendidos de Amazon.es."
    }),

    categories: async function (body) {
      const r = await top20.categories(!!(body && body.refresh));
      if (!r.ok) return { ok: false, reason: r.reason, hint: "Configura KEEPA_API_KEY en el backend." };
      return { ok: true, data: { categories: r.categories, at: r.at || null, cached: !!r.cached } };
    },

    list: async function (body) {
      const r = await top20.list(body && (body.category || body.categoryId), {
        range: body && body.range,
        limit: body && body.limit,
        refresh: !!(body && body.refresh)
      });
      if (!r.ok) {
        return {
          ok: false,
          reason: r.reason,
          hint: r.reason === "category_required" ? "Indica un node id de categoria (usa la accion categories)."
            : r.reason === "keepa_not_configured" ? "Configura KEEPA_API_KEY en el backend." : null
        };
      }
      return { ok: true, data: r.data, cached: !!r.cached, stale: !!r.stale };
    },

    refresh: async function (body) {
      const r = await top20.refresh(body && (body.category || body.categories));
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, data: r };
    }
  }
};

module.exports = adapter;
