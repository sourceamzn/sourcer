const jobs = require("../lib/jobs");
const gtin = require("../lib/gtin");
const { adapters } = require("../adapters");

/* POST /suppliers/start  -> { ok, jobId }   (responde al instante)
   GET  /suppliers/status/:id -> estado, fuentes en curso y resultados parciales */
function startSuppliers(req, res) {
  const body = req.body || {};
  const eanOnly = body.eanOnly !== false;
  const eans = gtin.normalizeAll([].concat(body.eans || [], body.ean || []));
  if (eanOnly && !eans.length && !body.asin) return res.status(400).json({ ok: false, reason: "producto_sin_ean", hint: "El modo exacto solo busca por EAN/UPC. Esta ficha no tiene un codigo valido: no se buscan parecidos por nombre, marca, modelo ni foto." });
  const hasId = eans.length || body.asin || body.name || body.model || body.brand || body.query;
  if (!hasId) return res.status(400).json({ ok: false, reason: "producto_sin_identidad", hint: "La ficha no aporta nombre, marca, modelo ni EAN." });
  const jobId = jobs.start(Object.assign({}, body, { eans: eans, eanOnly: eanOnly }), adapters.inverso);
  res.json({ ok: true, jobId: jobId });
}
function statusSuppliers(req, res) {
  const st = jobs.status(req.params.id);
  if (!st) return res.status(404).json({ ok: false, reason: "job_no_encontrado", hint: "El trabajo caduca a los 30 min o el servidor se reinicio." });
  res.json({ ok: true, job: st });
}
module.exports = { startSuppliers, statusSuppliers };