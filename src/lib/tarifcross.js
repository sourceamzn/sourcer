"use strict";
/* Cruce masivo de una tarifa de proveedor con Amazon (Keepa).

   El distribuidor manda un Excel con cientos o miles de EAN y su precio. Se
   cruzan TODOS por lotes de hasta 100 codigos en la misma llamada a Keepa
   (`product?code=`), en dos fases para gastar lo minimo:

     Fase 1 (1 token por producto encontrado): EAN -> ASIN, precio Buy Box,
       ventas, BSR, ofertas. Se calcula el precio maximo de compra (lib/plan)
       y se compara con el precio de la tarifa. Lo que no existe en Amazon o
       no deja margen se queda aqui.
     Fase 2 (+2 tokens, solo los que dejan margen): historial de Buy Box 90 d
       para aplicar la regla del cliente (Amazon o la marca solos, o sin 2
       vendedores FBA de terceros = no es oportunidad).

   Keepa recarga ~21 tokens/min: el trabajo corre en segundo plano, espera la
   recarga cuando no hay saldo y guarda el progreso en la base de datos
   (colecciones `tariff_runs` = resumen, `tariff_run_data` = filas). Si el
   servidor se reinicia, el trabajo se retoma donde se quedo. */

const crypto = require("crypto");
const docs = require("./docstore");
const keepaCost = require("./keepacost");
const gtin = require("./gtin");
const planLib = require("./plan");
const events = require("./events");

const RUNS = "tariff_runs";
const DATA = "tariff_run_data";
const MAX_ROWS = 5000;
const KEEP_RUNS = 30;
const RESERVE = 40;            /* tokens que se dejan para abrir fichas y buscar */
const BATCH = 100;             /* maximo de codigos por llamada a Keepa */

let deps = null;               /* inyectable en tests */
function inv() {
  if (deps) return deps;
  const inverso = require("../adapters/inverso");
  return {
    keepaRequest: inverso.keepaRequest,
    keepaProductsByAsins: inverso.keepaProductsByAsins,
    metricsFromKeepa: inverso.metricsFromKeepa,
    keepaReady: inverso.keepaReady,
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  };
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round(num(n) * 100) / 100; }
function now() { return new Date().toISOString(); }

/* Unidades del anuncio de Amazon: si es un pack, el precio de la tarifa (por
   unidad) no es comparable sin multiplicar. Se avisa, no se corrige solo. */
function packOf(prod) {
  const t = String((prod && prod.title) || "").toLowerCase();
  let n = Math.max(num(prod && prod.packageQuantity), num(prod && prod.numberOfItems));
  const m = t.match(/\b(?:pack|lote|set|caja)\s*(?:de\s*)?(\d{1,3})\b/) || t.match(/\b(\d{1,3})\s*(?:x|uds?\.?|unidades|piezas)\b/) || t.match(/\bx\s?(\d{1,3})\b/);
  if (m && num(m[1]) > 1 && num(m[1]) <= 200) n = Math.max(n, num(m[1]));
  return n > 1 ? n : 1;
}

/* Precio de la tarifa SIN IVA (asi cotizan casi todos los mayoristas). */
function netOf(row, vatMode, vat) {
  const p = num(row.net) || num(row.price);
  if (!(p > 0)) return 0;
  return vatMode === "con" ? p / (1 + vat / 100) : p;
}

/* Resultado de una fila frente al plan del producto. */
function evaluate(row, m, params, vatMode, phase) {
  const p = params;
  const vat = num(p.vat), rec = num(p.recargo);
  const plan = planLib.planFor(m, p);
  const net = netOf(row, vatMode, vat);
  const pack = m.pack || 1;
  const costReal = net * pack * (1 + (vat + rec) / 100);
  const room = plan.pvNet - plan.feesReal;
  const profit = room - costReal;
  const out = {
    ean: row.ean, name: row.name || "", brand: row.brand || "", reference: row.reference || "",
    net: r2(net), pack: pack, stock: row.stock == null ? null : row.stock,
    asin: m.asin, title: String(m.title || "").slice(0, 200), image: m.image || "", url: m.url,
    amzBrand: m.brand || "", pvp: plan.pvp, sales: m.sales || 0, bsr: m.bsr || 0,
    fbaThird: m.fbaThird == null ? null : m.fbaThird, thirdParty: m.thirdParty == null ? null : m.thirdParty,
    amazonSells: Boolean(m.amazonSells),
    priceMaxNet: r2(plan.priceMaxNet / pack), breakEvenNet: r2(plan.breakEvenNet / pack),
    profit: r2(profit), roi: costReal > 0 ? r2((profit / costReal) * 100) : 0,
    margin: plan.pvNet > 0 ? r2((profit / plan.pvNet) * 100) : 0,
    phase: phase, estado: plan.estado, reasons: plan.reasons.slice(0, 4),
    bbKind: plan.buyBox && plan.buyBox.kind, feesSource: plan.fees && plan.fees.source
  };
  /* Banda de precio de la tarifa frente a lo que se puede pagar. */
  if (!(plan.pvp > 0)) out.band = "sin_precio_amazon";
  else if (net <= out.priceMaxNet && out.priceMaxNet > 0) out.band = "margen";
  else if (net <= out.breakEvenNet && out.breakEvenNet > 0) out.band = "justo";
  else out.band = "sin_margen";
  /* Veredicto final: margen + regla de la Buy Box (solo tras la fase 2). */
  if (out.band === "margen" && phase === 2 && plan.estado !== "descarte") out.verdict = plan.estado === "apt" ? "oportunidad" : "revisar";
  else if (out.band === "margen" && phase === 2) out.verdict = "buybox_cerrada";
  else if (out.band === "margen" || out.band === "justo") out.verdict = phase === 2 ? (plan.estado === "descarte" ? "buybox_cerrada" : "justo") : "pendiente";
  else out.verdict = out.band;
  /* Sin buybox ya se sabe si hay 0-1 vendedores: no hay Buy Box que compartir
     y no merece la pena pagar la fase 2. */
  if (phase === 1 && out.verdict === "pendiente" && m.thirdParty != null && num(m.thirdParty) <= 1) {
    out.verdict = "buybox_cerrada";
    out.reasons.unshift("Solo " + num(m.thirdParty) + " vendedor(es) aparte de Amazon: la Buy Box no se comparte.");
  }
  if (pack > 1) out.reasons.unshift("El anuncio de Amazon parece un pack de " + pack + " uds: el coste se ha multiplicado por " + pack + ". Revisa que la tarifa sea por unidad.");
  return out;
}

const ORDER = { oportunidad: 0, revisar: 1, justo: 2, pendiente: 3, buybox_cerrada: 4, sin_margen: 5, sin_precio_amazon: 6 };
function sortRows(rows) {
  return rows.sort(function (a, b) {
    const d = (ORDER[a.verdict] == null ? 9 : ORDER[a.verdict]) - (ORDER[b.verdict] == null ? 9 : ORDER[b.verdict]);
    if (d) return d;
    return num(b.profit) * Math.max(1, num(b.sales)) - num(a.profit) * Math.max(1, num(a.sales));
  });
}

function summarize(run, rows) {
  const c = { oportunidad: 0, revisar: 0, justo: 0, pendiente: 0, buybox_cerrada: 0, sin_margen: 0, sin_precio_amazon: 0 };
  rows.forEach(function (r) { c[r.verdict] = (c[r.verdict] || 0) + 1; });
  run.counts = c;
  run.found = rows.length;
}

/* ---------- API publica ---------- */

/* Prepara las filas (EAN valido + precio) y crea el trabajo. */
async function create(input) {
  input = input || {};
  const raw = Array.isArray(input.rows) ? input.rows : [];
  const byEan = {};
  let sinEan = 0, sinPrecio = 0;
  raw.slice(0, MAX_ROWS * 2).forEach(function (r) {
    if (!r || typeof r !== "object") return;
    const ean = gtin.normalize(gtin.digitsOnly(String(r.ean || r.upc || r.gtin || "")));
    if (!ean) { sinEan++; return; }
    const price = num(r.net) || num(r.price);
    if (!(price > 0)) { sinPrecio++; return; }
    byEan[ean] = {
      ean: ean, name: String(r.name || "").slice(0, 200), brand: String(r.brand || "").slice(0, 80),
      reference: String(r.reference || r.model || "").slice(0, 80), net: num(r.net) || null, price: num(r.price) || null,
      stock: r.stock == null || r.stock === "" ? null : num(r.stock)
    };
  });
  const items = Object.keys(byEan).map(function (k) { return byEan[k]; }).slice(0, MAX_ROWS);
  if (!items.length) return { ok: false, reason: "sin_filas_validas", sinEan: sinEan, sinPrecio: sinPrecio };
  const id = "t" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const run = {
    id: id, createdAt: now(), updatedAt: now(), state: "en_cola",
    fileName: String(input.fileName || "").slice(0, 120), source: String(input.source || "").slice(0, 60),
    contactId: String(input.contactId || "").slice(0, 200), vatMode: input.vatMode === "con" ? "con" : "sin",
    params: input.params && typeof input.params === "object" ? input.params : {},
    total: items.length, sinEan: sinEan, sinPrecio: sinPrecio,
    looked: 0, found: 0, deep: 0, deepDone: 0, tokens: 0, waits: 0, notFound: 0, counts: {}, message: "En cola"
  };
  await docs.put(DATA, id, { id: id, items: items, rows: [], cursor: 0, deepQueue: null });
  await docs.put(RUNS, id, run);
  await prune();
  kick();
  return { ok: true, run: run };
}

async function prune() {
  try {
    const list = (await docs.list(RUNS)).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    for (let i = KEEP_RUNS; i < list.length; i++) { await docs.del(RUNS, list[i].id); await docs.del(DATA, list[i].id); }
  } catch (e) {}
}

async function list() {
  const l = await docs.list(RUNS);
  return l.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}
async function get(id, opts) {
  opts = opts || {};
  const run = await docs.get(RUNS, id);
  if (!run) return null;
  const data = await docs.get(DATA, id);
  let rows = (data && data.rows) || [];
  if (opts.verdict) rows = rows.filter(function (r) { return opts.verdict.split(",").indexOf(r.verdict) !== -1; });
  return { run: run, rows: sortRows(rows.slice()).slice(0, opts.limit || 2000) };
}
async function remove(id) {
  const a = await docs.del(RUNS, id);
  await docs.del(DATA, id);
  if (current === id) cancelled[id] = true;
  return a;
}
async function cancel(id) {
  const run = await docs.get(RUNS, id);
  if (!run) return null;
  if (run.state === "en_cola" || run.state === "cruzando" || run.state === "esperando_tokens") {
    cancelled[id] = true;
    run.state = "cancelado"; run.message = "Cancelado por el usuario"; run.updatedAt = now();
    await docs.put(RUNS, id, run);
  }
  return run;
}

/* ---------- trabajador (uno a la vez) ---------- */
let current = null, running = false;
const cancelled = {};

function kick() {
  if (running) return;
  running = true;
  loop().catch(function (e) { try { events.add("tarifa_cruce", { phase: "error", error: String(e && e.message || e).slice(0, 200) }); } catch (x) {} })
    .then(function () { running = false; current = null; });
}

async function nextRun() {
  const l = await docs.list(RUNS);
  const open = l.filter(function (r) { return r.state === "en_cola" || r.state === "cruzando" || r.state === "esperando_tokens"; })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  return open[0] || null;
}

async function loop() {
  for (let guard = 0; guard < 1000; guard++) {
    const run = await nextRun();
    if (!run) return;
    current = run.id;
    await process1(run);
  }
}

async function save(run, data) {
  run.updatedAt = now();
  if (data) await docs.put(DATA, run.id, data);
  if (cancelled[run.id]) return false;
  const live = await docs.get(RUNS, run.id);
  if (!live || live.state === "cancelado") return false;
  await docs.put(RUNS, run.id, run);
  return true;
}

/* Espera de recarga de Keepa: devuelve cuantos tokens se pueden gastar. */
async function waitTokens(run, need) {
  const d = inv();
  for (let i = 0; i < 120; i++) {
    const b = keepaCost.budget(RESERVE);
    if (b == null || b >= Math.min(need, 20)) return b == null ? need : b;
    run.state = "esperando_tokens";
    run.waits++;
    const refill = keepaCost.usage.refillRate || 21;
    const mins = Math.max(1, Math.ceil((Math.min(need, 60) - b) / refill));
    run.message = "Esperando recarga de Keepa (" + (keepaCost.usage.tokensLeft || 0) + " tokens; ~" + mins + " min)";
    if (!(await save(run))) return -1;
    await d.sleep(60000);
    /* La recarga no se ve hasta la siguiente respuesta de Keepa: se estima. */
    keepaCost.usage.tokensLeft = (keepaCost.usage.tokensLeft || 0) + refill;
  }
  return 0;
}

async function process1(run) {
  const d = inv();
  const data = (await docs.get(DATA, run.id)) || { items: [], rows: [], cursor: 0 };
  if (!d.keepaReady()) {
    run.state = "error"; run.message = "Keepa no esta configurado (KEEPA_API_KEY)."; await save(run); return;
  }
  const params = planLib.planParams({ params: run.params || {} });
  run.state = "cruzando";
  run.startedAt = run.startedAt || now();
  if (!(await save(run))) return;
  const rowsByEan = {};
  data.rows.forEach(function (r) { rowsByEan[r.ean] = r; });
  const itemsByEan = {};
  data.items.forEach(function (it) { itemsByEan[it.ean] = it; });

  /* ----- Fase 1: EAN -> producto (sin buybox) ----- */
  while (data.cursor < data.items.length) {
    const left = data.items.length - data.cursor;
    const can = await waitTokens(run, Math.min(BATCH, left));
    if (can < 0) return;
    const n = Math.max(1, Math.min(BATCH, left, can || BATCH));
    const chunk = data.items.slice(data.cursor, data.cursor + n);
    run.state = "cruzando";
    run.message = "Fase 1 · buscando en Amazon " + (data.cursor + 1) + "–" + (data.cursor + chunk.length) + " de " + data.items.length;
    if (!(await save(run))) return;
    const r = await d.keepaRequest("product", { code: chunk.map(function (x) { return x.ean; }).join(","), stats: "90", "code-limit": "3" });
    if (!r.ok) {
      const err = JSON.stringify(r.error || r.reason || "").toLowerCase();
      /* 429 / sin tokens: se espera y se reintenta el mismo lote. */
      if (/429|token/.test(err) || /keepa_http_429/.test(String(r.reason))) { keepaCost.usage.tokensLeft = 0; continue; }
      run.state = "error"; run.message = "Keepa respondio con error: " + String(r.reason || "error"); await save(run, data); return;
    }
    run.tokens += num(r.data && r.data.tokensConsumed);
    const prods = (r.data && r.data.products) || [];
    /* Un EAN puede dar varios ASIN (variantes, packs): se elige el que mas vende. */
    const best = {};
    prods.forEach(function (p) {
      const codes = [].concat(p.eanList || [], p.upcList || []).map(function (c) { return gtin.normalize(gtin.digitsOnly(String(c))); });
      chunk.forEach(function (it) {
        if (codes.indexOf(it.ean) === -1) return;
        const rank = (p.stats && p.stats.current && num(p.stats.current[3]) > 0) ? num(p.stats.current[3]) : 1e12;
        if (!best[it.ean] || rank < best[it.ean].rank) best[it.ean] = { p: p, rank: rank, alt: best[it.ean] ? best[it.ean].alt + 1 : 0 };
        else best[it.ean].alt++;
      });
    });
    chunk.forEach(function (it) {
      const b = best[it.ean];
      if (!b) { run.notFound++; return; }
      const m = d.metricsFromKeepa(b.p);
      m.pack = packOf(b.p);
      const row = evaluate(it, m, params, run.vatMode, 1);
      if (b.alt) row.alternatives = b.alt;
      rowsByEan[it.ean] = row;
    });
    data.cursor += chunk.length;
    run.looked = data.cursor;
    data.rows = Object.keys(rowsByEan).map(function (k) { return rowsByEan[k]; });
    summarize(run, data.rows);
    if (!(await save(run, data))) return;
  }

  /* ----- Fase 2: Buy Box 90 d solo para los que dejan margen ----- */
  if (!data.deepQueue) {
    data.deepQueue = data.rows.filter(function (r) { return r.phase === 1 && r.verdict === "pendiente"; })
      .sort(function (a, b) { return num(b.profit) - num(a.profit); }).map(function (r) { return r.asin + "|" + r.ean; });
    run.deep = data.deepQueue.length;
  }
  while (data.deepQueue.length) {
    const can = await waitTokens(run, Math.min(data.deepQueue.length * 3, 60));
    if (can < 0) return;
    const n = Math.max(1, Math.min(20, Math.floor((can || 60) / 3), data.deepQueue.length));
    const chunk = data.deepQueue.slice(0, n);
    run.state = "cruzando";
    run.message = "Fase 2 · Buy Box 90 d de los que dejan margen (" + (run.deepDone + 1) + "–" + (run.deepDone + chunk.length) + " de " + run.deep + ")";
    if (!(await save(run))) return;
    const before = keepaCost.usage.consumed;
    const r = await d.keepaProductsByAsins(chunk.map(function (x) { return x.split("|")[0]; }), 0, { buybox: true });
    run.tokens += Math.max(0, keepaCost.usage.consumed - before);
    if (!r.ok && !(r.products || []).length) {
      if (/429|token/i.test(String(r.reason))) { keepaCost.usage.tokensLeft = 0; continue; }
      run.message = "Fase 2 incompleta: " + String(r.reason || "error");
      break;
    }
    const byAsin = {};
    (r.products || []).forEach(function (p) { if (p && p.asin) byAsin[String(p.asin).toUpperCase()] = p; });
    chunk.forEach(function (k) {
      const asin = k.split("|")[0], ean = k.split("|")[1];
      const p = byAsin[asin], it = itemsByEan[ean];
      if (!p || !it) return;
      const m = d.metricsFromKeepa(p);
      m.pack = packOf(p);
      const row = evaluate(it, m, params, run.vatMode, 2);
      if (rowsByEan[ean] && rowsByEan[ean].alternatives) row.alternatives = rowsByEan[ean].alternatives;
      rowsByEan[ean] = row;
    });
    data.deepQueue = data.deepQueue.slice(chunk.length);
    run.deepDone += chunk.length;
    data.rows = Object.keys(rowsByEan).map(function (k) { return rowsByEan[k]; });
    summarize(run, data.rows);
    if (!(await save(run, data))) return;
  }
  run.state = "terminado";
  run.finishedAt = now();
  const c = run.counts || {};
  run.message = "Terminado: " + run.found + " de " + run.total + " EAN existen en Amazon · " + (c.oportunidad || 0) + " oportunidad(es) · " + (c.revisar || 0) + " a revisar · " + (c.justo || 0) + " justos · " + run.tokens + " tokens Keepa.";
  await save(run, data);
  if (run.contactId) { try { await require("./learn").tariffResult(run.contactId, data.rows); } catch (e) {} }
  try { events.add("tarifa_cruce", { phase: "fin", id: run.id, total: run.total, found: run.found, ops: c.oportunidad || 0, tokens: run.tokens }); } catch (e) {}
}

/* Al arrancar el servidor: retoma los trabajos a medias. */
function resume() { setTimeout(function () { nextRun().then(function (r) { if (r) kick(); }).catch(function () {}); }, 5000); }

module.exports = {
  create, list, get, remove, cancel, resume, kick,
  _forTests: { evaluate: evaluate, packOf: packOf, netOf: netOf, sortRows: sortRows, setDeps: function (x) { deps = x; }, loop: loop, idle: function () { return !running; } }
};
