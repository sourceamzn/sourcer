const { adapters } = require("../adapters");
const { config } = require("../config");
const pkg = require("../../package.json");

/* Prueba de verdad: cada sonda hace la operacion real (no solo mira si hay
   clave). Devuelve evidencia: cuantos resultados, una muestra y el motivo del
   fallo. Asi "ok" significa "ha devuelto datos", no "esta configurado". */

function evidence(items, limit) {
  return (items || []).slice(0, limit || 3).map(function (it) {
    return {
      name: String((it && it.name) || "").slice(0, 110),
      price: it && it.price != null ? it.price : null,
      currency: (it && it.currency) || (it && it.attrs && it.attrs.currency) || null,
      ean: (it && (it.ean || (it.attrs && it.attrs.ean))) || "",
      url: (it && it.url) || ""
    };
  });
}

function normalize(id, r, started) {
  const data = (r && r.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const verified = items.length > 0;
  return {
    id,
    ok: !!(r && r.ok) && verified,
    responded: !!(r && r.ok),
    verified,
    count: items.length,
    ms: Date.now() - started,
    reason: (r && r.reason) || (verified ? null : "sin_resultados"),
    hint: (r && r.hint) || null,
    detail: (r && r.detail) || null,
    status: (r && r.status) || null,
    sample: evidence(items, id === "icecat" ? 1 : 3)
  };
}

const PROBES = {
  cjdropshipping: async function () {
    return adapters.cjdropshipping.actions.search({ query: "phone", max: 3 });
  },
  lidl: async function () {
    return adapters.lidl.actions.search({ query: "leche" });
  },
  icecat: async function () {
    const ean = String(process.env.ICECAT_SELFTEST_EAN || "4948570114344").trim();
    return adapters.icecat.actions.lookup({ ean: ean });
  },
  aliexpress: async function () {
    return adapters.aliexpress.actions.ping();
  }
};

function selftest(req, res) {
  const body = req.body || {};
  const asked = Array.isArray(body.sources) && body.sources.length
    ? body.sources.map(function (s) { return String(s).toLowerCase(); })
    : Object.keys(PROBES);
  const known = asked.filter(function (id) { return PROBES[id]; });
  const unknown = asked.filter(function (id) { return !PROBES[id]; });

  Promise.all(known.map(async function (id) {
    const started = Date.now();
    try {
      const out = await PROBES[id]();
      const row = normalize(id, out, started);
      if (id === "aliexpress") {
        row.configured = !!(out && out.configured);
        row.ok = false;
        row.verified = false;
        row.reason = (out && out.reason) || "aliexpress_no_configurado";
        row.hint = (out && out.note) || "Falta la aprobacion de la app de AliExpress.";
      }
      return row;
    } catch (e) {
      return {
        id,
        ok: false,
        responded: false,
        verified: false,
        count: 0,
        ms: Date.now() - started,
        reason: "excepcion",
        hint: String((e && e.message) || e),
        sample: []
      };
    }
  })).then(function (results) {
    res.json({
      ok: results.length > 0 && results.every(function (r) { return r.ok; }),
      service: pkg.name,
      version: pkg.version,
      time: new Date().toISOString(),
      env: config.env,
      verified: results.filter(function (r) { return r.verified; }).length,
      results: results,
      unknown: unknown
    });
  });
}

module.exports = selftest;
