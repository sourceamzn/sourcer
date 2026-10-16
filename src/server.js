const express = require("express");
const { config } = require("./config");
const health = require("./routes/health");
const sourcing = require("./routes/sourcing");
const coverage = require("./routes/coverage");
const alerts = require("./routes/alerts");
const suppliers = require("./routes/suppliers");
const scheduler = require("./lib/scheduler");
const store = require("./lib/store");
const pkg = require("../package.json");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use(function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowAll = config.allowedOrigins === "*";
  const allowed = allowAll ? "*" : config.allowedOrigins.split(",").map((o) => o.trim());
  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.json({ ok: true, service: pkg.name, version: pkg.version, docs: "/health" }));
app.get("/health", health);
app.get("/coverage", coverage);
app.use("/alerts", alerts);
app.post("/suppliers/start", suppliers.startSuppliers);
app.get("/suppliers/status/:id", suppliers.statusSuppliers);
app.post("/sourcing/:source/:action", sourcing);

/* Inicializa el almacen del vigilante en segundo plano (no bloquea el arranque). */
store.init().catch(function () {});

app.use((req, res) => res.status(404).json({ ok: false, reason: "not_found", path: req.path }));
app.use((err, req, res, next) => res.status(500).json({ ok: false, reason: String((err && err.message) || err) }));

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(pkg.name + " escuchando en http://localhost:" + config.port);
    console.log("Entorno: " + config.env + " | Marketplace: " + config.market);
  });
  scheduler.start();
}

module.exports = app;
