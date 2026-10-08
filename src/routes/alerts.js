const express = require("express");
const { config } = require("../config");
const store = require("../lib/store");
const scheduler = require("../lib/scheduler");

const router = express.Router();

function ah(fn) {
  return function (req, res) {
    fn(req, res).catch(function (e) {
      res.status(500).json({ ok: false, reason: String((e && e.message) || e) });
    });
  };
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/* Estado completo: productos vigilados + avisos + estado del vigilante. */
router.get(
  "/",
  ah(async (req, res) => {
    await store.init();
    const watches = await store.listWatches();
    const alerts = await store.listAlerts({ includeDismissed: req.query.dismissed === "1", limit: 200 });
    res.json({
      ok: true,
      mode: store.mode(),
      watches: watches,
      alerts: alerts,
      scheduler: scheduler.status()
    });
  })
);

/* Poner un producto bajo vigilancia. */
router.post(
  "/watch",
  ah(async (req, res) => {
    await store.init();
    const b = req.body || {};
    const source = str(b.source);
    if (!source) return res.status(400).json({ ok: false, reason: "source_required" });
    if (!str(b.name) && !str(b.url) && !str(b.asin) && !str(b.ean)) {
      return res.status(400).json({ ok: false, reason: "identity_required" });
    }
    const price = numOrNull(b.price != null ? b.price : b.base_price);
    const target = numOrNull(b.targetPct != null ? b.targetPct : b.target_pct);
    const watch = {
      id: store.newId("w"),
      source: source,
      name: str(b.name),
      brand: str(b.brand),
      model: str(b.model),
      reference: str(b.reference),
      ean: str(b.ean).replace(/\D/g, ""),
      url: str(b.url),
      asin: str(b.asin).toUpperCase(),
      image: str(b.image),
      key: str(b.key) || undefined,
      base_price: price,
      last_price: price,
      target_pct: target != null ? Math.max(0.5, target) : config.alerts.defaultTargetPct,
      active: true,
      created_at: store.nowIso(),
      last_checked: store.nowIso()
    };
    await store.saveWatch(watch);
    res.json({ ok: true, watch: watch });
  })
);

/* Editar umbral o activar/desactivar la vigilancia. */
router.post(
  "/watch/:id",
  ah(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.targetPct != null || b.target_pct != null) {
      const t = numOrNull(b.targetPct != null ? b.targetPct : b.target_pct);
      if (t != null) patch.target_pct = Math.max(0.5, t);
    }
    if (b.active != null) patch.active = !!b.active;
    if (b.base_price != null) patch.base_price = numOrNull(b.base_price);
    const watch = await store.updateWatch(req.params.id, patch);
    if (!watch) return res.status(404).json({ ok: false, reason: "watch_not_found" });
    res.json({ ok: true, watch: watch });
  })
);

/* Dejar de vigilar. */
router.delete(
  "/watch/:id",
  ah(async (req, res) => {
    const done = await store.deleteWatch(req.params.id);
    if (!done) return res.status(404).json({ ok: false, reason: "watch_not_found" });
    res.json({ ok: true, id: req.params.id });
  })
);

/* Historico de precios de un producto vigilado. */
router.get(
  "/history/:id",
  ah(async (req, res) => {
    const history = await store.priceHistory(req.params.id, 200);
    res.json({ ok: true, id: req.params.id, count: history.length, history: history });
  })
);

/* Descartar un aviso. */
router.post(
  "/dismiss",
  ah(async (req, res) => {
    const id = str((req.body || {}).id);
    if (!id) return res.status(400).json({ ok: false, reason: "id_required" });
    const alert = await store.dismissAlert(id);
    if (!alert) return res.status(404).json({ ok: false, reason: "alert_not_found" });
    res.json({ ok: true, alert: alert });
  })
);

/* Forzar una comprobacion ahora mismo (util para no esperar las 12 h). */
router.post(
  "/run",
  ah(async (req, res) => {
    const out = await scheduler.runOnce("manual");
    res.json(out);
  })
);

router.get(
  "/stats",
  ah(async (req, res) => {
    await store.init();
    const stats = await store.stats();
    res.json({ ok: true, stats: stats, scheduler: scheduler.status() });
  })
);

module.exports = router;
