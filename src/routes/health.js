const { config, amazonReady, keepaReady, feedReady, scrapingReady } = require("../config");
const { list } = require("../adapters");
const vault = require("../lib/vault");
const store = require("../lib/store");
const scheduler = require("../lib/scheduler");
const pkg = require("../../package.json");

function health(req, res) {
  res.json({
    ok: true,
    service: pkg.name,
    version: pkg.version,
    time: new Date().toISOString(),
    env: config.env,
    market: config.market,
    vault: vault.available(),
    sources: {
      amazon: amazonReady(),
      keepa: keepaReady(),
      outletpc: true,
      lidl: true,
      iherb: scrapingReady() || feedReady("iherb"),
      scraping: scrapingReady()
    },
    alerts: {
      enabled: config.alerts.enabled,
      store: store.mode(),
      intervalHours: config.alerts.intervalHours,
      defaultTargetPct: config.alerts.defaultTargetPct,
      last: scheduler.status().last
    },
    adapters: list()
  });
}

module.exports = health;
