const { config } = require("../config");
const store = require("./store");
const { adapters } = require("../adapters");
const inverso = require("../adapters/inverso");
const top20 = require("./top20");

/* Vigilante de precios: cada X horas (12 por defecto) revisa el precio actual de cada
   producto vigilado, lo guarda en el historico y crea un aviso cuando la bajada
   supera el umbral configurado por producto. */

let timer = null;
let running = false;
let consecutiveTimer = null;
let last = { at: null, checked: 0, dropped: 0, alerts: 0, errors: 0 };
let sweepTimer = null;
let sweepStartup = null;
let sweeping = false;
let lastSweep = { at: null, sources: [], items: 0, newItems: 0, drops: 0, alerts: 0, errors: 0 };
let top20Timer = null;
let top20Startup = null;
let refreshingTop20 = false;

function norm(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function round2(n) {
  return Math.round((isFinite(n) ? n : 0) * 100) / 100;
}

function priceFromKeepa(payload) {
  try {
    const prod = payload && payload.products && payload.products[0];
    if (!prod) return 0;
    const st = prod.stats || {};
    const cur = (i) => {
      const c = st.current && st.current[i];
      return c == null || c < 0 ? 0 : c;
    };
    const c = cur(18) || cur(1) || cur(0) || cur(10);
    return c > 0 ? Math.round(c) / 100 : 0;
  } catch (e) {
    return 0;
  }
}

function matchItem(w, items) {
  if (!Array.isArray(items) || !items.length) return null;
  const wurl = String(w.url || "").trim();
  if (wurl) {
    const byUrl = items.find((it) => it.url && String(it.url).trim() === wurl);
    if (byUrl) return byUrl;
  }
  const wref = norm(w.reference);
  if (wref) {
    const byRef = items.find((it) => it.reference && norm(it.reference) === wref);
    if (byRef) return byRef;
  }
  const wn = norm(w.name);
  if (wn) {
    const byName = items.find((it) => norm(it.name) === wn);
    if (byName) return byName;
  }
  return null;
}

async function currentPrice(w) {
  if (w.source === "keepa" || w.source === "amazon") {
    if (!w.asin) return { ok: false, reason: "asin_required" };
    const keepa = adapters.keepa;
    const r = await keepa.actions.product({ asin: w.asin, buybox: true, stats: "1" });
    const price = priceFromKeepa(r && (r.data || r));
    if (!price) return { ok: false, reason: "no_price" };
    return { ok: true, price: price, via: "keepa" };
  }
  const adapter = adapters[w.source];
  if (!adapter || !adapter.actions || typeof adapter.actions.search !== "function") {
    return { ok: false, reason: "source_not_supported" };
  }
  const q = String(w.name || w.reference || "").trim();
  if (!q) return { ok: false, reason: "query_required" };
  const r = await adapter.actions.search({ query: q, max: 24 });
  const data = r && r.ok ? r.data : null;
  const items = data && (data.items || (data.data && data.data.items));
  const it = matchItem(w, items);
  const price = it ? Number(it.price) : 0;
  if (!price || !isFinite(price) || price <= 0) return { ok: false, reason: "no_match" };
  return { ok: true, price: price, via: w.source };
}

async function runOnce(actor) {
  if (running) return { ok: false, reason: "already_running" };
  running = true;
  const summary = { at: store.nowIso(), actor: actor || "manual", checked: 0, drops: 0, alerts: 0, errors: 0, results: [] };
  try {
    await store.init();
    const watches = (await store.listWatches()).filter((w) => w.active !== false);
    const existing = await store.listAlerts({ includeDismissed: false, limit: 500 });
    for (const w of watches) {
      const prev = w.last_price != null && isFinite(w.last_price) ? Number(w.last_price) : w.base_price != null ? Number(w.base_price) : null;
      let res;
      try {
        res = await currentPrice(w);
      } catch (e) {
        res = { ok: false, reason: String((e && e.message) || e) };
      }
      if (!res.ok) {
        summary.errors++;
        await store.updateWatch(w.id, { last_checked: store.nowIso() });
        summary.results.push({ id: w.id, name: w.name, ok: false, reason: res.reason });
        continue;
      }
      const price = res.price;
      await store.recordPrice(w.id, price);
      summary.checked++;
      let drop = 0;
      if (prev && prev > 0) drop = ((prev - price) / prev) * 100;
      const target = Number(w.target_pct != null ? w.target_pct : config.alerts.defaultTargetPct);
      summary.results.push({ id: w.id, name: w.name, ok: true, price: price, prev: prev, drop: round2(drop), via: res.via });
      if (prev && prev > 0 && drop >= target) {
        summary.drops++;
        const already = existing.find((a) => a.watch_id === w.id && Number(a.price) === Number(price));
        if (!already) {
          const alert = {
            id: store.newId("al"),
            watch_id: w.id,
            kind: "price_drop",
            title: w.name || "Producto vigilado",
            detail:
              "El precio de compra ha bajado un " +
              round2(drop) +
              " % (" +
              round2(prev) +
              " € → " +
              round2(price) +
              " €). Umbral del " +
              target +
              " %.",
            price: round2(price),
            prev_price: round2(prev),
            pct: round2(drop),
            at: store.nowIso(),
            dismissed: false
          };
          await store.addAlert(alert);
          existing.push(alert);
          summary.alerts++;
        }
      }
    }
    last = { at: summary.at, checked: summary.checked, dropped: summary.drops, alerts: summary.alerts, errors: summary.errors };
    return { ok: true, summary: summary };
  } finally {
    running = false;
  }
}

/* ---- Barrido de catalogo (paso 1): altas nuevas y bajadas sin palabra clave ---- */

function sweepSources() {
  return String(config.sweep.sources || "")
    .split(",")
    .map(function (s) {
      return s.trim().toLowerCase();
    })
    .filter(function (s) {
      return s && adapters[s] && adapters[s].actions && typeof adapters[s].actions.browse === "function";
    });
}

async function sweepOnce(actor) {
  if (sweeping) return { ok: false, reason: "already_running" };
  sweeping = true;
  const summary = { at: store.nowIso(), actor: actor || "manual", sources: [], items: 0, newItems: 0, drops: 0, alerts: 0, errors: 0, results: [] };
  try {
    await store.init();
    for (const source of sweepSources()) {
      const entry = { source: source, ok: false, items: 0, newItems: 0, drops: 0, alerts: 0 };
      try {
        const baseline = typeof store.catalogHasSource === "function" ? !(await store.catalogHasSource(source)) : false;
        const r = await adapters[source].actions.browse({ max: config.sweep.max });
        const data = r && r.ok ? r.data : null;
        const items = (data && data.items) || [];
        entry.items = items.length;
        if (!r || !r.ok || !items.length) {
          entry.error = (r && r.reason) || "no_items";
          summary.errors++;
          summary.results.push(entry);
          continue;
        }
        await store.catalogUpsert(source, items);
        const existing = await store.listAlerts({ includeDismissed: false, limit: 500 });
        for (const it of items) {
          const name = it.name || "Producto de catalogo";
          const url = it.url || "";
          const ident = it.reference || it.ean || it.url || name;
          if (it.isNew && !baseline) {
            summary.newItems++;
            entry.newItems++;
            const key = "catalog_new|" + source + "|" + ident;
            if (!existing.some((a) => a.detail && a.detail.indexOf(key) !== -1)) {
              const alert = {
                id: store.newId("al"),
                watch_id: null,
                kind: "catalog_new",
                title: name,
                detail: "[" + key + "] Alta nueva en " + source + (it.price ? " · " + round2(it.price) + " €" : "") + (url ? " · " + url : ""),
                price: it.price != null ? round2(it.price) : null,
                prev_price: null,
                pct: null,
                at: store.nowIso(),
                dismissed: false
              };
              await store.addAlert(alert);
              existing.push(alert);
              summary.alerts++;
              entry.alerts++;
            }
          }
          if (it.dropPct != null && it.dropPct >= config.sweep.dropPct) {
            summary.drops++;
            entry.drops++;
            const key = "catalog_drop|" + source + "|" + ident + "|" + it.dropPct;
            if (!existing.some((a) => a.detail && a.detail.indexOf(key) !== -1)) {
              const alert = {
                id: store.newId("al"),
                watch_id: null,
                kind: "catalog_drop",
                title: name,
                detail:
                  "[" + key + "] Bajada del " + it.dropPct + " % en " + source +
                  (it.dropFrom ? " (" + round2(it.dropFrom) + " € → " + round2(it.price) + " €)" : "") +
                  (url ? " · " + url : ""),
                price: it.price != null ? round2(it.price) : null,
                prev_price: it.dropFrom != null ? round2(it.dropFrom) : null,
                pct: it.dropPct,
                at: store.nowIso(),
                dismissed: false
              };
              await store.addAlert(alert);
              existing.push(alert);
              summary.alerts++;
              entry.alerts++;
            }
          }
        }
        entry.ok = true;
        summary.items += entry.items;
      } catch (e) {
        entry.error = String((e && e.message) || e);
        summary.errors++;
      }
      summary.sources.push(source);
      summary.results.push(entry);
    }
    lastSweep = { at: summary.at, sources: summary.sources, items: summary.items, newItems: summary.newItems, drops: summary.drops, alerts: summary.alerts, errors: summary.errors };
    return { ok: true, summary: summary };
  } finally {
    sweeping = false;
  }
}

function start() {
  if (consecutiveTimer || timer) return;
  if (!config.alerts.enabled) {
    console.log("[alerts] desactivado (ALERTS_ENABLED=false)");
    startTop20();
    return;
  }
  const ms = config.alerts.intervalHours * 3600 * 1000;
  store
    .init()
    .then(() => {
      console.log(
        "[alerts] vigilante activo · cada " + config.alerts.intervalHours + " h · umbral por defecto " + config.alerts.defaultTargetPct + " % · almacen " + store.mode()
      );
    })
    .catch(() => {});
  consecutiveTimer = setTimeout(() => runOnce("startup").catch(() => {}), 90 * 1000);
  if (consecutiveTimer.unref) consecutiveTimer.unref();
  timer = setInterval(() => runOnce("timer").catch(() => {}), ms);
  if (timer.unref) timer.unref();
  if (config.sweep.enabled && sweepSources().length) {
    const msSweep = config.sweep.intervalHours * 3600 * 1000;
    console.log(
      "[alerts] barrido de catalogo activo · cada " + config.sweep.intervalHours + " h · bajadas >= " + config.sweep.dropPct + " % · fuentes " + sweepSources().join(", ")
    );
    sweepStartup = setTimeout(() => sweepOnce("startup").catch(() => {}), 120 * 1000);
    if (sweepStartup.unref) sweepStartup.unref();
    sweepTimer = setInterval(() => sweepOnce("timer").catch(() => {}), msSweep);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  startTop20();
}

/* Refresco programado del panel Top 20. Sin TOP20_CATEGORIES refresca el
   agregado "mas vendidos de Amazon.es"; con categorias, esas. */
function startTop20() {
  if (top20Timer || top20Startup) return;
  if (!config.top20.enabled) return;
  const cats = top20.configuredCategories();
  const ms = config.top20.intervalHours * 3600 * 1000;
  console.log("[top20] refresco activo · cada " + config.top20.intervalHours + " h · " + (cats.length ? ("categorias " + cats.join(", ")) : "mas vendidos de Amazon.es (agregado)"));
  top20Startup = setTimeout(() => refreshTop20("startup").catch(() => {}), 150 * 1000);
  if (top20Startup.unref) top20Startup.unref();
  top20Timer = setInterval(() => refreshTop20("timer").catch(() => {}), ms);
  if (top20Timer.unref) top20Timer.unref();
}

/* El refresco programado del Top 20 gasta decenas de tokens de Keepa por
   pasada. Para que la cuenta no se vacie sola (y los tokens puedan recuperarse)
   solo se ejecuta si el saldo supera TOP20_MIN_TOKENS. */
async function top20BudgetOk() {
  /* El coste dominante son las listas de Best Sellers (50 tokens cada una): el
     minimo efectivo es el coste estimado del refresco, no un valor fijo bajo. */
  const estimate = top20.estimateRefreshTokens ? top20.estimateRefreshTokens() : 0;
  const min = Math.max(config.top20.minTokens || 0, estimate);
  try {
    const tok = inverso.keepaTokens ? await inverso.keepaTokens() : null;
    if (!tok || typeof tok.tokensLeft !== "number") return { ok: true };
    if (tok.tokensLeft < min) {
      return { ok: false, reason: "keepa_bajo_minimo", tokensLeft: tok.tokensLeft, min: min };
    }
    return { ok: true, tokensLeft: tok.tokensLeft };
  } catch (e) {
    return { ok: true };
  }
}

async function refreshTop20(actor) {
  if (refreshingTop20) return { ok: false, reason: "already_running" };
  refreshingTop20 = true;
  try {
    const budget = await top20BudgetOk();
    if (!budget.ok) {
      console.log("[top20] refresco " + (actor || "manual") + " omitido: Keepa con " + budget.tokensLeft + " tokens (minimo " + budget.min + ")");
      return { ok: false, reason: budget.reason, tokensLeft: budget.tokensLeft, min: budget.min };
    }
    const r = await top20.refresh();
    if (r && r.ok) console.log("[top20] refresco " + (actor || "manual") + " · categorias " + r.refreshed.length + " · items " + (r.refreshed.reduce(function (a, x) { return a + (x.count || 0); }, 0)));
    return r;
  } finally {
    refreshingTop20 = false;
  }
}

function stop() {
  if (timer) clearInterval(timer);
  if (consecutiveTimer) clearTimeout(consecutiveTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  if (sweepStartup) clearTimeout(sweepStartup);
  if (top20Timer) clearInterval(top20Timer);
  if (top20Startup) clearTimeout(top20Startup);
  timer = null;
  consecutiveTimer = null;
  sweepTimer = null;
  sweepStartup = null;
  top20Timer = null;
  top20Startup = null;
}

function status() {
  return {
    enabled: config.alerts.enabled,
    running: running,
    intervalHours: config.alerts.intervalHours,
    defaultTargetPct: config.alerts.defaultTargetPct,
    last: last,
    sweep: {
      enabled: config.sweep.enabled,
      running: sweeping,
      intervalHours: config.sweep.intervalHours,
      dropPct: config.sweep.dropPct,
      sources: sweepSources(),
      last: lastSweep
    },
    top20: top20.status()
  };
}

module.exports = { start, stop, runOnce, sweepOnce, status, refreshTop20 };
