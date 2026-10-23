const { config, amazonReady, keepaReady, feedReady, scrapingReady, apifyReady, bigbuyReady, icecatReady, aliexpressReady, cjReady, visionReady } = require("../config");
const { list } = require("../adapters");
const { profileMeta } = require("../adapters/sources/catalog");
const vault = require("../lib/vault");
const store = require("../lib/store");
const scheduler = require("../lib/scheduler");
const top20 = require("../lib/top20");
const apifyLib = require("../lib/apify");
const pkg = require("../../package.json");

function health(req, res) {
  res.json({
    ok: true,
    service: pkg.name,
    version: pkg.version,
    time: new Date().toISOString(),
    env: config.env,
    market: config.market,
    /* Numero de claves API cargadas. Sirve para comprobar en vivo si la
       variable API_KEYS llego al proceso (0 = no configurada). */
    auth: { apiKeys: config.apiKeys.length },
    vault: vault.available(),
    sources: {
      amazon: amazonReady(),
      keepa: keepaReady(),
      /* Apify (clave unica): descubrimiento, 1688, Alibaba, Made-in-China,
         Google Shopping y busqueda por foto. */
      apify: apifyReady(),
      a1688: apifyReady() && Boolean(config.apify.actors.a1688),
      alibaba: apifyReady() && Boolean(config.apify.actors.alibaba),
      madeinchina: apifyReady() && Boolean(config.apify.actors.mic),
      gshopping: apifyReady() && Boolean(config.apify.actors.shopping),
      /* Resolucion de ofertas por EAN (actor distinto al buscador por texto). */
      gshopping_ean: apifyReady() && Boolean(config.apify.actors.shoppingEan),
      explorar: apifyReady() && Boolean(config.apify.actors.shopping),
      foto: apifyReady() && Boolean(config.apify.actors.image),
      /* Comparacion visual de fotos: opcional; sin clave se usan heuristicas. */
      vision: visionReady(),
      visionProvider: config.imageAi.enabled ? config.imageAi.provider : "off",
      /* Busqueda inversa (Amazon -> proveedor): depende de Keepa para los
         candidatos de la demanda; los proveedores usan el resto de fuentes. */
      inverso: keepaReady(),
      /* Panel Top 20 · mas vendidos amazon.es (Keepa Best Sellers, domain 9). */
      top20: keepaReady(),
      outletpc: true,
      lidl: true,
      iherb: scrapingReady() || feedReady("iherb"),
      scraping: scrapingReady(),
      /* Proveedores con API propia. bigbuy = mayorista (precio neto sin IVA,
         EAN y stock); aliexpress/cj = dropshipping. */
      bigbuy: bigbuyReady(),
      /* Icecat: usuario/contrasena (no API key) y IP autorizada en su panel. */
      icecat: icecatReady(),
      aliexpress: aliexpressReady(),
      cj: cjReady(),
      /* Fuentes generadas por perfil (outlets y mayoristas): lectura web del
         catalogo (JSON-LD / microdata / anclas) sin claves. */
      selectavision: true,
      yesstyle: true,
      corteingles: true,
      zalandoprive: false,
      gemimarket: true,
      norica: true,
      famosa: true,
      planafabrega: true,
      vallesviasat: true,
      /* Canales del PDF. */
      storefronts: true,
      tarifas: true,
      liquidaciones: true,
      newsletters: true
    },
    alerts: {
      enabled: config.alerts.enabled,
      store: store.mode(),
      intervalHours: config.alerts.intervalHours,
      defaultTargetPct: config.alerts.defaultTargetPct,
      last: scheduler.status().last,
      sweep: {
        enabled: config.sweep.enabled,
        intervalHours: config.sweep.intervalHours,
        dropPct: config.sweep.dropPct,
        sources: config.sweep.sources,
        last: scheduler.status().sweep.last
      }
    },
    /* Consumo real de Apify desde el arranque (peticiones ejecutadas, no de cache). */
    apifyUsage: apifyLib.stats,
    keepaUsage: require("../lib/keepacost").snapshot(),
    top20: top20.status(),
    adapters: list(),
    /* Catalogo del PDF con las particularidades por proveedor (EAN, stock
       exacto, limite por cliente, pedido minimo y tramos) que aplica el motor. */
    catalog: profileMeta()
  });
}

module.exports = health;
