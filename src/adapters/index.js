const outletpc = require("./outletpc");
const lidl = require("./lidl");
const iherb = require("./iherb");
const amazon = require("./amazon");
const keepa = require("./keepa");
const web = require("./web");
const storefronts = require("./storefronts");
const newsletters = require("./newsletters");
const { tarifa, liquidaciones } = require("./tarifa");
const { buildAdapters } = require("./sources/catalog");

/* Catalogo completo de fuentes del PDF: tres fuentes "de fabrica" (Outlet PC,
   Lidl, iHerb), las APIs (Amazon SP-API, Keepa), la lectura web, y las fuentes
   generadas por perfil (outlets y mayoristas/fabricantes), mas los canales
   (storefronts FBA, tarifas, liquidaciones, newsletters). */
const adapters = Object.assign(
  { outletpc, lidl, iherb, amazon, keepa, web },
  buildAdapters(),
  { storefronts, tarifas: tarifa, liquidaciones, newsletters }
);

function list() {
  return Object.keys(adapters).map((id) => ({
    id,
    label: adapters[id].label,
    kind: adapters[id].kind,
    actions: Object.keys(adapters[id].actions)
  }));
}

async function dispatch(source, action, body) {
  const adapter = adapters[source];
  if (!adapter) {
    return { status: 404, body: { ok: false, reason: "source_not_found", source, available: Object.keys(adapters) } };
  }
  const handler = adapter.actions[action];
  if (typeof handler !== "function") {
    return { status: 404, body: { ok: false, reason: "action_not_found", source, action, available: Object.keys(adapter.actions) } };
  }
  try {
    const result = await handler(body || {}, {});
    return { status: 200, body: Object.assign({ source, action }, result) };
  } catch (e) {
    return { status: 500, body: { ok: false, source, action, reason: String((e && e.message) || e) } };
  }
}

module.exports = { adapters, list, dispatch };
