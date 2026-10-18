const path = require("path");
/* En produccion dotenv esta instalado; en tests sin node_modules se sigue
   leyendo process.env sin romper el arranque. */
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (e) {}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

const config = {
  env: clean(process.env.NODE_ENV) || "development",
  port: parseInt(clean(process.env.PORT) || "3000", 10),
  market: clean(process.env.MARKETPLACE_ID) || "A1RKKUPIHCS9HS",
  region: clean(process.env.SPAPI_REGION) || "eu-west-1",
  /* Seguridad. API_KEYS admite varias claves separadas por comas; la misma
     clave se pega en el navegador (Conexiones) y viaja en X-API-Key. */
  allowedOrigins: clean(process.env.ALLOWED_ORIGINS) || "https://tools.bruneagroup.com",
  apiKeys: clean(process.env.API_KEYS).split(",").map(function (k) { return k.trim(); }).filter(Boolean),
  rateLimitPerMin: Math.max(0, parseInt(clean(process.env.RATE_LIMIT_PER_MIN) || "60", 10) || 0),
  beaconRatePerMin: Math.max(0, parseInt(clean(process.env.BEACON_RATE_PER_MIN) || "30", 10) || 0),
  beaconMaxBytes: Math.max(1024, parseInt(clean(process.env.BEACON_MAX_BYTES) || "16384", 10) || 16384),
  beaconMaxLines: Math.min(Math.max(parseInt(clean(process.env.BEACON_MAX_LINES) || "25", 10) || 25, 1), 50),
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
  /* SP-API: reintentos ante 429/5xx y cuantas fichas se completan con tarifas
     reales o restricciones de listado por busqueda (0 = no llamar). */
  spapi: {
    maxRetries: Math.min(Math.max(parseInt(clean(process.env.SPAPI_MAX_RETRIES) || "3", 10) || 3, 0), 5),
    retryMs: Math.min(Math.max(parseInt(clean(process.env.SPAPI_RETRY_MS) || "600", 10) || 600, 200), 5000),
    feesMax: Math.min(Math.max(parseInt(clean(process.env.SPAPI_FEES_MAX) || "8", 10) || 0, 0), 20),
    restrictionsMax: Math.min(Math.max(parseInt(clean(process.env.SPAPI_RESTRICTIONS_MAX) || "8", 10) || 0, 0), 20)
  },
  feeds: ["outletpc", "lidl", "iherb", "selectavision", "yesstyle", "corteingles", "gemimarket", "norica", "famosa", "planafabrega", "vallesviasat"].reduce(function (acc, id) {
    acc[id] = clean(process.env["FEED_" + id.toUpperCase()]);
    return acc;
  }, {}),
  scraping: {
    provider: clean(process.env.SCRAPER_PROVIDER) || "none",
    apiKey: clean(process.env.SCRAPER_API_KEY)
  },
  /* --- Descubrimiento de proveedores por buscador (Brave Search API) ---
     La pieza que rompe la dependencia de 12 webs fijas: dado un EAN o
     marca+modelo, devuelve paginas de mayoristas/distribuidores reales. */
  discovery: {
    provider: clean(process.env.DISCOVERY_PROVIDER) || "brave",
    apiKey: clean(process.env.BRAVE_API_KEY),
    country: clean(process.env.DISCOVERY_COUNTRY) || "es",
    lang: clean(process.env.DISCOVERY_LANG) || "es"
  },
  /* --- Apify: una sola clave (APIFY_TOKEN) para buscador, lectura web,
     1688, Alibaba, Made-in-China, Google Shopping y busqueda por foto.
     Los actores se llaman por ID y se pueden cambiar sin tocar codigo. --- */
  apify: {
    token: clean(process.env.APIFY_TOKEN),
    base: clean(process.env.APIFY_BASE) || "https://api.apify.com",
    country: clean(process.env.APIFY_COUNTRY) || "es",
    cacheMin: Math.max(0, parseInt(clean(process.env.APIFY_CACHE_MIN) || "120", 10) || 0),
    maxCostPerOp: Math.max(0, parseFloat(clean(process.env.APIFY_MAX_COST_PER_OP) || "0.50") || 0),
    timeoutSec: Math.min(Math.max(parseInt(clean(process.env.APIFY_TIMEOUT_SEC) || "50", 10) || 50, 10), 300),
    actors: {
      search: clean(process.env.APIFY_SEARCH_ACTOR) || "apify/google-search-scraper",
      crawl: clean(process.env.APIFY_CRAWL_ACTOR) || "apify/website-content-crawler",
      image: clean(process.env.APIFY_IMAGE_ACTOR) || "devcake/scraper-by-image",
      a1688: clean(process.env.APIFY_1688_ACTOR) || "datacach/1688-search-scraper",
      alibaba: clean(process.env.APIFY_ALIBABA_ACTOR) || "happitap/alibaba-product-scraper",
      mic: clean(process.env.APIFY_MIC_ACTOR) || "agenscrape/made-in-china-com-product-scraper",
      shopping: clean(process.env.APIFY_SHOPPING_ACTOR) || "automation-lab/google-shopping-scraper",
      shoppingEan: clean(process.env.APIFY_SHOPPING_EAN_ACTOR) || "scrapewise/google-shopping",
      aliexpress: clean(process.env.APIFY_ALIEXPRESS_ACTOR)
    }
  },
  /* --- Proveedores/marketplaces con API (clave por tienda) --- */
  bigbuy: {
    apiKey: clean(process.env.BIGBUY_API_KEY),
    base: clean(process.env.BIGBUY_BASE) || "https://api.bigbuy.eu",
    iso: clean(process.env.BIGBUY_ISO) || "es"
  },
  aliexpress: {
    appKey: clean(process.env.ALIEXPRESS_APP_KEY),
    appSecret: clean(process.env.ALIEXPRESS_APP_SECRET),
    session: clean(process.env.ALIEXPRESS_SESSION),
    trackingId: clean(process.env.ALIEXPRESS_TRACKING_ID),
    base: clean(process.env.ALIEXPRESS_BASE) || "https://api-sg.aliexpress.com/sync"
  },
  cj: {
    apiKey: clean(process.env.CJ_API_KEY),
    base: clean(process.env.CJ_BASE) || "https://developers.cjdropshipping.com/api2.0/v1"
  },
  /* --- Identificador EAN/UPC -> producto (nombre/marca) --- */
  /* Busqueda de proveedores (inverso.searchSuppliers). */
  suppliers: {
    maxResults: Math.max(3, parseInt(clean(process.env.SUPPLIER_MAX_RESULTS) || "20", 10) || 20),
    maxResultsCap: Math.max(3, parseInt(clean(process.env.SUPPLIER_MAX_RESULTS_CAP) || "40", 10) || 40),
    /* Consultas por fuente gratuita / de pago (Apify cobra cada ejecucion). */
    maxQueries: Math.min(Math.max(parseInt(clean(process.env.SUPPLIER_MAX_QUERIES) || "4", 10) || 4, 1), 5),
    maxQueriesPaid: Math.min(Math.max(parseInt(clean(process.env.SUPPLIER_MAX_QUERIES_PAID) || "2", 10) || 2, 1), 4),
    /* Con tantos resultados utiles ya no se prueba la siguiente consulta. */
    enough: Math.max(1, parseInt(clean(process.env.SUPPLIER_ENOUGH) || "5", 10) || 5)
  },
  /* Fase 4 · puntuacion de coincidencia. Enriquecimiento de ofertas "a
     revisar" sin EAN: cuantas fichas se abren por busqueda y con que timeout. */
  match: {
    /* Cotejo previo a mostrar resultados: se abren fichas de proveedor para
       leer precio, foto, descripcion, color, talla y caracteristicas. */
    enrichMax: Math.min(Math.max(parseInt(clean(process.env.MATCH_ENRICH_MAX) || "24", 10) || 0, 0), 60),
    enrichMs: Math.min(Math.max(parseInt(clean(process.env.MATCH_ENRICH_MS) || "9000", 10) || 9000, 1000), 20000),
    imageMax: Math.min(Math.max(parseInt(clean(process.env.MATCH_IMAGE_MAX) || "8", 10) || 0, 0), 20),
    imageMs: Math.min(Math.max(parseInt(clean(process.env.MATCH_IMAGE_MS) || "5000", 10) || 5000, 1000), 15000)
  },
  /* Regla Buy Box 90 d: umbrales en % y numero de vendedores cuyo nombre se
     consulta en Keepa para separar fabricante de terceros. */
  buybox: {
    sellerLookups: Math.min(Math.max(parseInt(clean(process.env.BB_SELLER_LOOKUPS) || "3", 10) || 3, 0), 6),
    manufacturerMin: Math.min(Math.max(parseFloat(clean(process.env.BB_MANUFACTURER_MIN) || "95", 10) || 95, 50), 100),
    thirdMax: Math.min(Math.max(parseFloat(clean(process.env.BB_THIRD_MAX) || "5", 10) || 5, 0), 50),
    singleThird: Math.min(Math.max(parseFloat(clean(process.env.BB_SINGLE_THIRD) || "97", 10) || 97, 50), 100)
  },
  /* Comparacion visual de fotos (opcional). Sin clave se usan las
     heuristicas de imagecheck y todo queda "sin confirmar visualmente".
     Un solo proveedor activo: anthropic | openai | gemini | openrouter. */
  imageAi: {
    enabled: clean(process.env.IMAGE_AI_ENABLED) !== "false",
    provider: clean(process.env.IMAGE_AI_PROVIDER) || "anthropic",
    /* Maximo de llamadas de vision por busqueda (0 = no llamar). */
    max: Math.max(0, parseInt(clean(process.env.IMAGE_AI_MAX) || "10", 10) || 0),
    timeoutMs: Math.min(Math.max(parseInt(clean(process.env.IMAGE_AI_TIMEOUT_MS) || "12000", 10) || 12000, 2000), 30000),
    cacheMin: Math.max(0, parseInt(clean(process.env.IMAGE_AI_CACHE_MIN) || "1440", 10) || 0),
    anthropic: {
      apiKey: clean(process.env.ANTHROPIC_API_KEY),
      model: clean(process.env.ANTHROPIC_MODEL) || "claude-sonnet-4-6"
    },
    openai: {
      apiKey: clean(process.env.OPENAI_API_KEY),
      model: clean(process.env.OPENAI_MODEL) || "gpt-4o-mini"
    },
    gemini: {
      apiKey: clean(process.env.GEMINI_API_KEY),
      model: clean(process.env.GEMINI_MODEL) || "gemini-2.0-flash"
    },
    openrouter: {
      apiKey: clean(process.env.OPENROUTER_API_KEY),
      model: clean(process.env.OPENROUTER_MODEL) || "google/gemini-2.0-flash-001"
    }
  },
  barcode: {
    provider: clean(process.env.BARCODE_PROVIDER) || "upcitemdb",
    apiKey: clean(process.env.UPCITEMDB_API_KEY)
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
    intervalHours: Math.max(1, parseInt(clean(process.env.TOP20_INTERVAL_HOURS) || "6", 10) || 6),
    limit: Math.min(Math.max(parseInt(clean(process.env.TOP20_LIMIT) || "20", 10) || 20, 1), 100),
    /* Vacio = agregado automatico de "los mas vendidos de Amazon.es": se
       detectan las categorias raiz (Keepa Category Lookup) y se toman las
       principales. Con valor = esas categorias concretas (node ids). */
    categories: clean(process.env.TOP20_CATEGORIES),
    maxCategories: Math.min(Math.max(parseInt(clean(process.env.TOP20_MAX_CATEGORIES) || "3", 10) || 3, 1), 20),
    /* Best Sellers de Keepa cuesta 50 tokens por lista: un refresco del Top 20
       gasta ~50 x nº de categorias. Antes que gastar sin control, ningun
       refresco (programado NI manual) se ejecuta si el saldo no cubre el coste
       estimado; este minimo es solo un suelo adicional. */
    minTokens: Math.max(0, parseInt(clean(process.env.TOP20_MIN_TOKENS) || "0", 10) || 0)
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

function apifyReady() {
  return Boolean(config.apify.token);
}

function discoveryReady() {
  return apifyReady() || Boolean(config.discovery.apiKey);
}

function bigbuyReady() {
  return Boolean(config.bigbuy.apiKey);
}

function aliexpressReady() {
  return Boolean(config.aliexpress.appKey && config.aliexpress.appSecret);
}

function cjReady() {
  return Boolean(config.cj.apiKey);
}

function visionReady() {
  const ai = config.imageAi || {};
  if (ai.enabled === false) return false;
  const p = ai[ai.provider] || {};
  return Boolean(p.apiKey);
}

module.exports = {
  config,
  amazonReady,
  keepaReady,
  feedReady,
  scrapingReady,
  apifyReady,
  discoveryReady,
  bigbuyReady,
  aliexpressReady,
  cjReady,
  visionReady
};
