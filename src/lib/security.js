"use strict";
/* Seguridad del backend: clave de API, CORS, limite de peticiones y topes del
   beacon de diagnostico. Sin dependencias externas y con los parametros
   inyectados para poder probar cada pieza de forma aislada. */

const crypto = require("crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value == null ? "" : value)).digest();
}

/* Comparacion en tiempo constante (evita filtrar la longitud de la clave). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function parseList(value) {
  return String(value == null ? "" : value)
    .split(",")
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

/* Middleware X-API-Key. Si no hay claves configuradas:
   - desarrollo: deja pasar (para pruebas locales),
   - produccion: falla cerrado (503) para no exponer las rutas privadas. */
function apiKeyGuard(opts) {
  const o = opts || {};
  const keys = o.keys || function () { return []; };
  const env = o.env || function () { return "development"; };
  return function (req, res, next) {
    const list = keys();
    if (!list.length) {
      if (env() === "production") {
        return res.status(503).json({
          ok: false,
          reason: "api_key_no_configurada",
          hint: "Define API_KEYS en el servidor y la misma clave en Conexiones."
        });
      }
      return next();
    }
    const got = req.headers && req.headers["x-api-key"];
    /* Clave de auditoria (AUDIT_KEYS): SOLO lectura (GET) y solo en las rutas
       de consulta. Sirve para que una auditoria automatica lea el diario y el
       consumo sin poder cambiar ni enviar nada. */
    const ro = (o.readOnlyKeys ? o.readOnlyKeys() : []) || [];
    if (got && ro.length && ro.some(function (k) { return safeEqual(k, got); })) {
      const path = String(req.originalUrl || req.url || "").split("?")[0];
      const allowed = ["/usage", "/feedback", "/learn", "/radar", "/tarifas/cruces", "/contacts", "/health"];
      if (req.method === "GET" && allowed.some(function (p) { return path === p || path.indexOf(p + "/") === 0; })) {
        req.apiKey = "audit"; req.readOnly = true;
        return next();
      }
      return res.status(403).json({ ok: false, reason: "clave_solo_lectura", hint: "La clave de auditoria solo puede consultar." });
    }
    if (!got || !list.some(function (k) { return safeEqual(k, got); })) {
      return res.status(401).json({
        ok: false,
        reason: "api_key_invalida",
        hint: "Falta la cabecera X-API-Key o no coincide con API_KEYS."
      });
    }
    req.apiKey = got;
    next();
  };
}

/* CORS. allowedOrigins = "*" permite todo; si no, solo los origenes listados.
   Los origenes no permitidos no reciben cabecera (el navegador bloquea). */
function cors(opts) {
  const o = opts || {};
  const origins = o.origins || function () { return ""; };
  return function (req, res, next) {
    const raw = String(origins() || "").trim();
    const allowAll = raw === "*";
    const list = allowAll ? [] : parseList(raw);
    const origin = req.headers && req.headers.origin;
    if (allowAll) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && list.indexOf(origin) !== -1) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Debug-Token");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    next();
  };
}

/* Limite por ventana fija de 60 s. Clave = API key o IP + ambito. */
const buckets = new Map();
let requests = 0;

function sweep(now) {
  buckets.forEach(function (b, k) {
    if (!b || now >= b.reset) buckets.delete(k);
  });
}

function rateLimit(opts) {
  const o = opts || {};
  const limit = o.limit || function () { return 0; };
  const scope = o.scope || "api";
  const keyOf = o.key || function (req) {
    const apiKey = req.headers && req.headers["x-api-key"];
    return (apiKey ? "k:" + apiKey : "ip:" + (req.ip || "desconocida"));
  };
  return function (req, res, next) {
    const max = Number(limit());
    if (!max || max <= 0) return next();
    const key = scope + "|" + keyOf(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.reset) {
      b = { count: 0, reset: now + 60000 };
      buckets.set(key, b);
    }
    b.count++;
    requests++;
    if (requests % 500 === 0) sweep(now);
    if (b.count > max) {
      const retry = Math.max(1, Math.ceil((b.reset - now) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({
        ok: false,
        reason: "demasiadas_peticiones",
        hint: "Espera " + retry + " s antes de volver a intentarlo."
      });
    }
    next();
  };
}

/* El beacon es publico: se limita el tamano antes de procesar el cuerpo. */
function beaconGuard(opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || function () { return 16384; };
  return function (req, res, next) {
    const len = Number((req.headers && req.headers["content-length"]) || 0);
    if (len > Number(maxBytes())) {
      return res.status(413).json({ ok: false, reason: "beacon_demasiado_grande" });
    }
    next();
  };
}

module.exports = { apiKeyGuard, cors, rateLimit, beaconGuard, parseList, safeEqual };
