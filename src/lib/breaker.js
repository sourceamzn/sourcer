"use strict";
/* Interruptor automatico por servicio externo.

   Si un servicio falla varias veces seguidas (caido, clave caducada, cuota
   agotada), se aparta unos minutos y se usa el respaldo, en vez de seguir
   esperando timeouts en cada busqueda. Pasado el enfriamiento se vuelve a
   probar con una sola peticion; si va bien, se cierra. */

const state = {};

function s(name) {
  return (state[name] = state[name] || { fails: 0, openUntil: 0, lastError: "", lastOk: null, lastFail: null, opens: 0 });
}

/* true = se puede llamar. */
function allow(name) {
  const st = s(name);
  return !(st.openUntil > Date.now());
}

function success(name) {
  const st = s(name);
  st.fails = 0; st.openUntil = 0; st.lastOk = new Date().toISOString();
}

/* opts: threshold (fallos seguidos, por defecto 3), coolMs (por defecto 5 min),
   hard (abre a la primera: clave invalida, sin saldo). */
function failure(name, reason, opts) {
  opts = opts || {};
  const st = s(name);
  st.fails++;
  st.lastError = String(reason || "error").slice(0, 160);
  st.lastFail = new Date().toISOString();
  const threshold = opts.threshold || 3;
  if (opts.hard || st.fails >= threshold) {
    st.openUntil = Date.now() + (opts.coolMs || 5 * 60000);
    st.opens++;
  }
}

function snapshot() {
  const out = {};
  Object.keys(state).forEach(function (k) {
    const st = state[k];
    out[k] = { open: st.openUntil > Date.now(), until: st.openUntil > Date.now() ? new Date(st.openUntil).toISOString() : null, fails: st.fails, lastError: st.lastError, lastOk: st.lastOk, lastFail: st.lastFail, opens: st.opens };
  });
  return out;
}

function reset(name) { if (name) delete state[name]; else Object.keys(state).forEach(function (k) { delete state[k]; }); }

module.exports = { allow, success, failure, snapshot, reset };
