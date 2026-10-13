const { dispatch } = require("../adapters");
const store = require("../lib/store");

/* Canales de fichero/correo: al leerlos se guardan para cruzarlos por EAN. */
const TARIFF_SOURCES = ["tarifas", "liquidaciones"];

async function sourcing(req, res) {
  const { source, action } = req.params;
  const out = await dispatch(source, action, req.body || {});
  const data = out.body && out.body.ok ? out.body.data : null;

  if (data && Array.isArray(data.items) && data.items.length) {
    try {
      if (TARIFF_SOURCES.indexOf(source) !== -1) {
        /* Tarifas y liquidaciones: se indexan por EAN para el cruce del motor. */
        await store.tariffUpsert(data.items, data.source || source);
      } else if (action === "browse") {
        /* Barrido de catalogo (paso 1): altas nuevas y bajadas de precio. */
        await store.catalogUpsert(source, data.items);
      }
    } catch (e) {
      /* el barrido sigue siendo util aunque no se pueda registrar el historico */
    }
  }

  res.status(out.status).json(out.body);
}

module.exports = sourcing;
