"use strict";
/* GET    /history?kind=candidates|suppliers   -> lista (sin datos)
   GET    /history/:kind/:id                   -> busqueda completa guardada
   DELETE /history/:kind/:id */
const express = require("express");
const history = require("../lib/history");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); }; }

router.get("/", ah(async function (req, res) {
  const kind = String((req.query && req.query.kind) || "candidates");
  res.json({ ok: true, kind: kind, rules: history.RULES[kind] || null, items: await history.list(kind) });
}));
router.get("/:kind/:id", ah(async function (req, res) {
  const d = await history.get(req.params.kind, req.params.id);
  if (!d) return res.status(404).json({ ok: false, reason: "no_guardada" });
  res.json({ ok: true, item: d });
}));
router.delete("/:kind/:id", ah(async function (req, res) {
  res.json({ ok: await history.del(req.params.kind, req.params.id) });
}));
module.exports = router;
