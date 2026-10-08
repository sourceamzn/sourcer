const { config } = require("../config");
const store = require("./store");
const { adapters } = require("../adapters");

/* Vigilante de precios: cada X horas (12 por defecto) revisa el precio actual de cada
   producto vigilado, lo guarda en el historico y crea un aviso cuando la bajada
   supera el umbral configurado por producto. */

let timer = null;
let running = false;
let consecutiveTimer = null;
let last = { at: null, checked: 0, dropped: 0, alerts: 0, errors: 0 };

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

function start() {
  if (consecutiveTimer || timer) return;
  if (!config.alerts.enabled) {
    console.log("[alerts] desactivado (ALERTS_ENABLED=false)");
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
}

function stop() {
  if (timer) clearInterval(timer);
  if (consecutiveTimer) clearTimeout(consecutiveTimer);
  timer = null;
  consecutiveTimer = null;
}

function status() {
  return {
    enabled: config.alerts.enabled,
    running: running,
    intervalHours: config.alerts.intervalHours,
    defaultTargetPct: config.alerts.defaultTargetPct,
    last: last
  };
}

module.exports = { start, stop, runOnce, status };
