const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function clean(value) {
  return value == null ? "" : String(value).trim();
}

const config = {
  env: clean(process.env.NODE_ENV) || "development",
  port: parseInt(clean(process.env.PORT) || "3000", 10),
  market: clean(process.env.MARKETPLACE_ID) || "A1RKKUPIHCS9HS",
  region: clean(process.env.SPAPI_REGION) || "eu-west-1",
  allowedOrigins: clean(process.env.ALLOWED_ORIGINS) || "*",
  vaultKey: clean(process.env.VAULT_KEY),
  amazon: {
    clientId: clean(process.env.LWA_CLIENT_ID),
    clientSecret: clean(process.env.LWA_CLIENT_SECRET),
    refreshToken: clean(process.env.SPAPI_REFRESH_TOKEN),
    sellerId: clean(process.env.SPAPI_SELLER_ID),
    accessKeyId: clean(process.env.AWS_ACCESS_KEY_ID),
    secretAccessKey: clean(process.env.AWS_SECRET_ACCESS_KEY),
    roleArn: clean(process.env.SPAPI_ROLE_ARN)
  },
  keepa: {
    apiKey: clean(process.env.KEEPA_API_KEY),
    domain: parseInt(clean(process.env.KEEPA_DOMAIN) || "9", 10)
  },
  feeds: ["outletpc", "lidl", "iherb", "selectavision", "yesstyle", "corteingles", "gemimarket", "norica", "famosa", "planafabrega", "vallesviasat"].reduce(function (acc, id) {
    acc[id] = clean(process.env["FEED_" + id.toUpperCase()]);
    return acc;
  }, {}),
  scraping: {
    provider: clean(process.env.SCRAPER_PROVIDER) || "none",
    apiKey: clean(process.env.SCRAPER_API_KEY)
  },
  /* Vigilante de precios (alertas). Si DATABASE_URL esta presente se usa Postgres;
     si no, un fichero JSON local para que el servicio funcione igual. */
  databaseUrl: clean(process.env.DATABASE_URL),
  alerts: {
    enabled: clean(process.env.ALERTS_ENABLED) !== "false",
    intervalHours: Math.max(1, parseInt(clean(process.env.ALERT_INTERVAL_HOURS) || "12", 10) || 12),
    defaultTargetPct: Math.max(0.5, parseFloat(clean(process.env.ALERT_TARGET_PCT) || "5") || 5),
    dataFile: clean(process.env.ALERTS_DATA_FILE) || path.join(__dirname, "..", "data", "alerts.json")
  },
  /* Barrido diario del catalogo (paso 1): recorre el surtido sin palabra clave,
     detecta altas nuevas y bajadas de precio y las deja como avisos. */
  sweep: {
    enabled: clean(process.env.CATALOG_SWEEP_ENABLED) !== "false",
    intervalHours: Math.max(1, parseInt(clean(process.env.CATALOG_SWEEP_INTERVAL_HOURS) || "24", 10) || 24),
    dropPct: Math.max(0.5, parseFloat(clean(process.env.CATALOG_SWEEP_DROP_PCT) || "10") || 10),
    max: Math.min(Math.max(parseInt(clean(process.env.CATALOG_SWEEP_MAX) || "40", 10) || 40, 1), 60),
    /* Barrido diario de TODAS las fuentes del PDF (no solo Outlet PC y Lidl). */
    sources: clean(process.env.CATALOG_SWEEP_SOURCES) || "outletpc,lidl,iherb,selectavision,yesstyle,corteingles,gemimarket,norica,famosa,planafabrega,vallesviasat"
  },
  /* Top 20 · Mas vendidos de amazon.es (guia). Fuente Keepa Best Sellers
     (domain 9). El panel lee de cache y se refresca de forma programada;
     TOP20_CATEGORIES admite una lista de node ids de categoria raiz. */
  top20: {
    enabled: clean(process.env.TOP20_ENABLED) !== "false",
    intervalHours: Math.max(1, parseInt(clean(process.env.TOP20_INTERVAL_HOURS) || "3", 10) || 3),
    limit: Math.min(Math.max(parseInt(clean(process.env.TOP20_LIMIT) || "20", 10) || 20, 1), 100),
    /* Vacio = agregado automatico de "los mas vendidos de Amazon.es": se
       detectan las categorias raiz (Keepa Category Lookup) y se toman las
       principales. Con valor = esas categorias concretas (node ids). */
    categories: clean(process.env.TOP20_CATEGORIES),
    maxCategories: Math.min(Math.max(parseInt(clean(process.env.TOP20_MAX_CATEGORIES) || "6", 10) || 6, 1), 20),
    /* El refresco programado gasta decenas de tokens por pasada. Solo se ejecuta
       si el saldo de Keepa supera este minimo, para que la cuenta no se vacie
       sola (con el plan actual, ~1 token/min, un refresco cada 3 h agota el tope). */
    minTokens: Math.max(0, parseInt(clean(process.env.TOP20_MIN_TOKENS) || "50", 10) || 50)
  }
};

function amazonReady() {
  return Boolean(
    config.amazon.clientId &&
      config.amazon.clientSecret &&
      config.amazon.refreshToken &&
      config.amazon.accessKeyId &&
      config.amazon.secretAccessKey
  );
}

function keepaReady() {
  return Boolean(config.keepa.apiKey);
}

function feedReady(source) {
  return Boolean(config.feeds[source]);
}

function scrapingReady() {
  return config.scraping.provider !== "none" && Boolean(config.scraping.apiKey);
}

module.exports = { config, amazonReady, keepaReady, feedReady, scrapingReady };
