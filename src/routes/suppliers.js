const jobs = require("../lib/jobs");
const { adapters } = require("../adapters");

/* POST /suppliers/start  -> { ok, jobId }   (responde al instante)
   GET  /suppliers/status/:id -> estado, fuentes en curso y resultados parciales */
function startSuppliers(req, res) {
  const body = req.body || {};
  const hasId = (body.ean && String(body.ean).replace(/\D/g, "").length >= 8) || body.name || body.model || body.brand || body.query;
  if (!hasId) return res.status(400).json({ ok: false, reason: "producto_sin_identidad", hint: "La ficha no aporta nombre, marca, modelo ni EAN." });
  const jobId = jobs.start(body, adapters.inverso);
  res.json({ ok: true, jobId: jobId });
}
function statusSuppliers(req, res) {
  const st = jobs.status(req.params.id);
  if (!st) return res.status(404).json({ ok: false, reason: "job_no_encontrado", hint: "El trabajo caduca a los 30 min o el servidor se reinicio." });
  res.json({ ok: true, job: st });
}
module.exports = { startSuppliers, statusSuppliers };