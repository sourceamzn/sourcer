"use strict";
/* Radar de oportunidades (lib/radar).
   GET   /radar              -> { cfg, items, running }
   PUT   /radar/cfg          { enabled, categories:[{id,name}], hour, limit, priceMin, priceMax, filters }
   POST  /radar/run          lanza una pasada ahora (en segundo plano)
   POST  /radar/seen         marca todo lo nuevo como visto
   PATCH /radar/:asin        { status: nuevo|visto|descartado } */
const express = require("express");
const radar = require("../lib/radar");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); }; }

router.get("/", ah(async function (req, res) {
  res.json({ ok: true, cfg: await radar.getCfg(), items: await radar.list(), running: radar.status().running });
}));
router.put("/cfg", ah(async function (req, res) { res.json({ ok: true, cfg: await radar.setCfg(req.body || {}) }); }));
router.post("/run", ah(async function (req, res) {
  if (radar.status().running) return res.json({ ok: true, running: true });
  radar.run("manual").catch(function () {});
  res.json({ ok: true, running: true });
}));
router.post("/seen", ah(async function (req, res) { res.json({ ok: true, n: await radar.markAllSeen() }); }));
router.patch("/:asin", ah(async function (req, res) {
  const it = await radar.setStatus(req.params.asin, req.body && req.body.status);
  if (!it) return res.status(404).json({ ok: false, reason: "no_encontrado" });
  res.json({ ok: true, item: it });
}));

module.exports = router;
