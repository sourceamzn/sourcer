"use strict";
/* Cruce masivo de tarifas con Amazon (lib/tarifcross).
   POST   /tarifas/cruces              { rows, fileName, source, contactId, vatMode, params } -> crea el trabajo
   GET    /tarifas/cruces              -> lista de cruces (resumen)
   GET    /tarifas/cruces/:id          -> resumen + filas (?verdict=oportunidad,revisar&limit=)
   POST   /tarifas/cruces/:id/cancel   -> cancela
   DELETE /tarifas/cruces/:id          -> borra */

const express = require("express");
const cross = require("../lib/tarifcross");
const store = require("../lib/store");
const tariffs = require("./tariffs");

const router = express.Router();
function ah(fn) {
  return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); };
}

router.post("/", ah(async function (req, res) {
  const b = req.body || {};
  if (!Array.isArray(b.rows) || !b.rows.length) return res.status(400).json({ ok: false, reason: "sin_filas" });
  if (b.rows.length > 5000) return res.status(413).json({ ok: false, reason: "demasiadas_filas", max: 5000 });
  const r = await cross.create(b);
  if (!r.ok) return res.status(400).json(r);
  /* La tarifa tambien queda indexada por EAN para «Buscar proveedores». */
  let indexed = 0;
  try {
    const prep = tariffs.prepareRows(b.rows);
    for (let i = 0; i < prep.items.length; i += 500) indexed += await store.tariffUpsert(prep.items.slice(i, i + 500), tariffs.sourceName(b.source || b.fileName || "tarifa"));
  } catch (e) {}
  res.json({ ok: true, run: r.run, indexed: indexed });
}));
router.get("/", ah(async function (req, res) { res.json({ ok: true, runs: await cross.list() }); }));
router.get("/:id", ah(async function (req, res) {
  const r = await cross.get(String(req.params.id), { verdict: req.query.verdict ? String(req.query.verdict) : "", limit: Math.min(5000, parseInt(req.query.limit || "2000", 10) || 2000) });
  if (!r) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  res.json(Object.assign({ ok: true }, r));
}));
router.post("/:id/cancel", ah(async function (req, res) {
  const r = await cross.cancel(String(req.params.id));
  if (!r) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  res.json({ ok: true, run: r });
}));
router.delete("/:id", ah(async function (req, res) { res.json({ ok: await cross.remove(String(req.params.id)) }); }));

module.exports = router;
