"use strict";
/* «Esto esta mal» y diario de pruebas.
   GET    /feedback/reasons      motivos por tipo (para los menus)
   GET    /feedback              correcciones
   POST   /feedback              { type, reason, target:{asin,ean,host,url,title,brand,query,snippet,runId,contactId}, correct, note, context }
   DELETE /feedback/:id          deshacer
   GET    /feedback/journal?days=7[&kind=]      diario (descarga JSON)
   GET    /feedback/journal/summary?days=7      resumen para el panel */
const express = require("express");
const fb = require("../lib/feedback");
const journal = require("../lib/journal");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); }; }

router.get("/reasons", function (req, res) { res.json({ ok: true, reasons: fb.REASONS }); });
router.get("/journal/summary", ah(async function (req, res) { res.json({ ok: true, summary: await journal.summary(Number(req.query && req.query.days) || 7) }); }));
router.get("/journal", ah(async function (req, res) {
  const q = req.query || {};
  const rows = await journal.list({ days: q.days, kind: q.kind, limit: q.limit });
  res.json({ ok: true, generatedAt: new Date().toISOString(), days: Number(q.days) || 7, count: rows.length, summary: await journal.summary(Number(q.days) || 7), corrections: (await fb.list()).slice(0, 500), entries: rows });
}));
router.get("/", ah(async function (req, res) { res.json({ ok: true, feedback: await fb.list() }); }));
/* Decisiones que solo vive el navegador (favoritos, etc.) para el diario. */
router.post("/log", ah(async function (req, res) {
  const b = req.body || {};
  const what = String(b.what || "").replace(/[^a-z0-9_]/gi, "").slice(0, 40);
  if (!what) return res.status(400).json({ ok: false, reason: "sin_que" });
  journal.add("decision", Object.assign({ what: what }, b.data && typeof b.data === "object" ? b.data : {}));
  res.json({ ok: true });
}));
router.get("/journal/months", ah(async function (req, res) { res.json({ ok: true, months: await journal.months() }); }));
router.post("/", ah(async function (req, res) {
  const r = await fb.create(req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
}));
router.delete("/:id", ah(async function (req, res) {
  const r = await fb.remove(String((req.params && req.params.id) || ""));
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
}));

module.exports = router;
