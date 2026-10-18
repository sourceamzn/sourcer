const express = require("express");
const { config } = require("./config");
const health = require("./routes/health");
const sourcing = require("./routes/sourcing");
const coverage = require("./routes/coverage");
const alerts = require("./routes/alerts");
const suppliers = require("./routes/suppliers");
const events = require("./lib/events");
const debug = require("./routes/debug");
const security = require("./lib/security");
const scheduler = require("./lib/scheduler");
const store = require("./lib/store");
const pkg = require("../package.json");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use(security.cors({ origins: function () { return config.allowedOrigins; } }));

const apiLimit = security.rateLimit({ scope: "api", limit: function () { return config.rateLimitPerMin; } });
const requireApiKey = security.apiKeyGuard({ keys: function () { return config.apiKeys; }, env: function () { return config.env; } });
const beaconLimit = security.rateLimit({
  scope: "beacon",
  limit: function () { return config.beaconRatePerMin; },
  /* El beacon es publico: se limita por IP, no por la clave que envie el cliente. */
  key: function (req) { return "ip:" + (req.ip || "desconocida"); }
});
const beaconGuard = security.beaconGuard({ maxBytes: function () { return config.beaconMaxBytes; } });

app.get("/", (req, res) => res.json({ ok: true, service: pkg.name, version: pkg.version, docs: "/health" }));
app.get("/health", health);
app.get("/coverage", coverage);
app.use("/alerts", apiLimit, requireApiKey, alerts);
app.post("/suppliers/start", apiLimit, requireApiKey, suppliers.startSuppliers);
app.get("/suppliers/status/:id", apiLimit, requireApiKey, suppliers.statusSuppliers);
app.get("/debug/events", events.guard, debug.getEvents);
app.post("/debug/beacon", beaconGuard, beaconLimit, debug.beacon);
app.get("/suppliers/log/:id", events.guard, debug.jobLog);
app.post("/sourcing/:source/:action", apiLimit, requireApiKey, sourcing);

/* Inicializa el almacen del vigilante en segundo plano (no bloquea el arranque). */
store.init().catch(function () {});

app.use((req, res) => res.status(404).json({ ok: false, reason: "not_found", path: req.path }));
app.use((err, req, res, next) => {
  events.add("error", { path: req.path, msg: String((err && err.message) || err) });
  res.status(500).json({ ok: false, reason: String((err && err.message) || err) });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(pkg.name + " escuchando en http://localhost:" + config.port);
    console.log("Entorno: " + config.env + " | Marketplace: " + config.market);
    console.log("Claves API cargadas: " + config.apiKeys.length);
  });
  scheduler.start();
}

module.exports = app;
