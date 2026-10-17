"use strict";
/* Politica de reintentos para APIs con limite de peticiones (SP-API 429).
   Aislada y sin dependencias para poder probarla sin red ni configuracion. */

function retryable(status) {
  return status === 0 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/* `Retry-After` (segundos) manda; si no hay, espera exponencial con jitter. */
function backoffMs(attempt, retryAfter, base) {
  const ra = Number(retryAfter);
  if (isFinite(ra) && ra > 0) return Math.min(Math.round(ra * 1000), 15000);
  const b = Number(base) > 0 ? Number(base) : 600;
  return Math.round(Math.min(b * Math.pow(2, attempt), 8000) * (0.75 + Math.random() * 0.5));
}

module.exports = { retryable, backoffMs };
