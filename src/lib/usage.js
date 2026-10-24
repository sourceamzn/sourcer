"use strict";
/* Consumo por servicio externo, por dia y por mes.

   Cada llamada de pago suma aqui (Keepa tokens, consultas de Brave, runs de
   Apify, llamadas y tokens de IA, SP-API, Icecat, correos). Se guarda en la
   base de datos (coleccion `usage`, un documento por mes) cada minuto, asi
   que sobrevive a reinicios. Lo lee el panel de APIs. */

const docs = require("./docstore");

const COLL = "usage";
let state = null, loading = null, dirty = false, timer = null;

function ymd(d) { return new Date(d || Date.now()).toISOString().slice(0, 10); }
function ym(d) { return ymd(d).slice(0, 7); }

async function load() {
  const month = ym();
  if (state && state.month === month) return state;
  if (state && dirty) { try { await flush(); } catch (e) {} }
  if (!loading) {
    loading = (async function () {
      let doc = null;
      try { doc = await docs.get(COLL, month); } catch (e) {}
      state = doc && doc.month === month ? doc : { month: month, total: {}, days: {} };
      loading = null;
      return state;
    })();
  }
  return loading;
}

function bump(obj, svc, metrics) {
  const o = obj[svc] = obj[svc] || {};
  Object.keys(metrics).forEach(function (k) {
    const v = Number(metrics[k]);
    if (!isFinite(v) || !v) return;
    o[k] = Math.round(((o[k] || 0) + v) * 1e6) / 1e6;
  });
}

/* add("keepa", { tokens: 3, requests: 1 }) — nunca lanza ni bloquea. */
function add(svc, metrics) {
  load().then(function (st) {
    bump(st.total, svc, metrics);
    const d = ymd();
    st.days[d] = st.days[d] || {};
    bump(st.days[d], svc, metrics);
    dirty = true;
    schedule();
  }).catch(function () {});
}

function schedule() {
  if (timer) return;
  timer = setTimeout(function () { timer = null; flush().catch(function () {}); }, 60000);
  if (timer.unref) timer.unref();
}
async function flush() {
  if (!state || !dirty) return;
  dirty = false;
  state.updatedAt = new Date().toISOString();
  await docs.put(COLL, state.month, state);
}

async function month(m) {
  const cur = await load();
  if (!m || m === cur.month) return cur;
  return (await docs.get(COLL, m)) || { month: m, total: {}, days: {} };
}

/* Ultimos N dias (pueden cruzar de mes). */
async function lastDays(n) {
  n = n || 30;
  const out = [];
  const months = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = ymd(Date.now() - i * 86400000);
    const m = d.slice(0, 7);
    if (!months[m]) months[m] = await month(m);
    out.push({ day: d, svc: (months[m].days && months[m].days[d]) || {} });
  }
  return out;
}

module.exports = { add, flush, month, lastDays, _reset: function () { state = null; dirty = false; } };
