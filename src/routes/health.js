const { config, amazonReady, keepaReady, feedReady, scrapingReady } = require("../config");
const { list } = require("../adapters");
const vault = require("../lib/vault");
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
    adapters: list()
  });
}

module.exports = health;
