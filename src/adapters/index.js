const outletpc = require("./outletpc");
const lidl = require("./lidl");
const iherb = require("./iherb");
const amazon = require("./amazon");
const keepa = require("./keepa");
const web = require("./web");

const adapters = { outletpc, lidl, iherb, amazon, keepa, web };

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
