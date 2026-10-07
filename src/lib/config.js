'use strict';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

/* Fastify trustProxy: false (no confiar), true (confiar en toda la cadena),
   un numero de saltos, o una IP/subred. En produccion, detras de un proxy,
   el valor seguro es "1". */
function parseTrustProxy(value, isProduction) {
  if (value === undefined || value === '') return isProduction ? 1 : false;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === 'false') return v === 'true';
  const n = Number.parseInt(v, 10);
  if (String(n) === v) return n;
  return String(value).trim();
}

/* Normaliza COOKIE_DOMAIN. Un valor con espacios, "·" o anotaciones pegadas
   (p. ej. ".dominio.com · COOKIE_SECURE = true") genera una cookie invalida
   que el navegador rechaza y la sesion no se guarda. Se toma el primer
   token valido; si no lo es, se ignora (cookie solo para el host). */
function cookieDomain(value) {
  if (!value) return undefined;
  const first = String(value).trim().split(/[\s;·]+/)[0];
  return /^\.?[a-z0-9.-]+$/i.test(first) ? first : undefined;
}

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const config = {
  env,
  isProduction,
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 3000),
  apiPublicUrl: process.env.API_PUBLIC_URL || 'http://localhost:3000',
  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    /* El certificado del proveedor se VERIFICA por defecto en produccion
       (fail-closed): sin verificacion, un atacante en la red podria
       interceptar la conexion. Si el proveedor usa una CA privada (Railway),
       hay que aportarla en PGSSL_CA; en desarrollo se puede relajar con
       PGSSL_REJECT_UNAUTHORIZED=false. */
    ssl: bool(process.env.PGSSL, false)
      ? {
          rejectUnauthorized: bool(process.env.PGSSL_REJECT_UNAUTHORIZED, isProduction),
          ca: process.env.PGSSL_CA || undefined,
        }
      : false,
    max: int(process.env.PG_POOL_MAX, 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET || (isProduction ? '' : 'dev-jwt-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  cookie: {
    secret: process.env.COOKIE_SECRET || (isProduction ? '' : 'dev-cookie-secret-change-me'),
    /* Nombre heredado. Se mantiene para no romper sesiones antiguas que aun
       viajen con esta cookie; el nombre real ahora depende del realm. */
    name: 'tn_sid',
    /* Una cookie de sesion por realm. Client Area, CRM y Manager viven en el
       mismo dominio (.toolsnexora.world), asi que con un unico nombre se
       pisaban la sesion entre ellos: al entrar al Area de Cliente se
       sobreescribia la cookie del CRM y este se rehidrataba con el actor
       equivocado (listas a cero, sin llegar a cerrar sesion). */
    names: {
      'client-area': 'tn_sid_client',
      crm: 'tn_sid_crm',
      terminal: 'tn_sid_terminal',
    },
    domain: cookieDomain(process.env.COOKIE_DOMAIN),
    secure: bool(process.env.COOKIE_SECURE, isProduction),
    sameSite: process.env.COOKIE_SAMESITE || 'lax',
  },
  cors: {
    origins: list(process.env.CORS_ORIGINS),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'ToolsNexora <no-reply@toolsnexora.world>',
    /* Tope de tiempo por conexion SMTP. En hosts que bloquean la salida SMTP
       (Railway) evita que el alta o la recuperacion se queden colgadas ~2 min. */
    timeoutMs: int(process.env.SMTP_TIMEOUT_MS, 5000),
  },
  /* Envio de correo por API HTTPS. Necesario cuando el host bloquea la
     salida SMTP (Railway: puertos 25/465/587 solo en plan Pro). Se usa si
     RESEND_API_KEY esta definido, con prioridad sobre SMTP. */
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.MAIL_FROM || 'ToolsNexora <no-reply@toolsnexora.world>',
  },
  clientAreaUrl: process.env.CLIENT_AREA_URL || 'https://clientarea.toolsnexora.world',
  rateLimit: {
    max: int(process.env.RATE_LIMIT_MAX, 100),
    window: process.env.RATE_LIMIT_WINDOW || '1 minute',
  },
  /* Limite de autenticacion. Antes era 1000/min (practicamente inexistente en
     un ataque de fuerza bruta). Ahora es estricto por defecto y configurable. */
  authRateLimit: {
    enabled: bool(process.env.AUTH_RATE_LIMIT_ENABLED, true),
    max: int(process.env.AUTH_RATE_LIMIT_MAX, 20),
    window: process.env.AUTH_RATE_LIMIT_WINDOW || '1 minute',
  },
  /* Cifrado en reposo de campos sensibles y del contenido de documentos. La
     clave es externa al codigo (entorno) y obligatoria en produccion. */
  encryption: {
    key: process.env.DATA_ENCRYPTION_KEY || '',
  },
  /* Seguridad de transporte/sesion. */
  security: {
    /* Firmar/proteger con Fastify. trustProxy=false evita que un cliente
       falsifique X-Forwarded-For y burle el rate-limit. Detras de Railway se
       configura con TRUST_PROXY=1. */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, isProduction),
    /* El token de sesion NUNCA debe viajar en el cuerpo de la respuesta: los
       navegadores lo guardaban en localStorage y queda al alcance de un XSS.
       Se mantiene la puerta trasera solo para transicion controlada. */
    bodyToken: bool(process.env.ALLOW_BODY_TOKEN, false),
  },
  csrf: {
    enabled: bool(process.env.CSRF_ENABLED, true),
    cookieName: process.env.CSRF_COOKIE_NAME || 'tn_csrf',
    headerName: process.env.CSRF_HEADER_NAME || 'x-csrf-token',
  },
  /* Limite del formulario publico de captacion. Es deliberadamente bajo para
     frenar el spam sin molestar a una persona real (5 envios cada 10 minutos
     por IP y, si procede, la propia validacion de correo del navegador). */
  publicRateLimit: {
    enabled: bool(process.env.PUBLIC_RATE_LIMIT_ENABLED, true),
    max: int(process.env.PUBLIC_RATE_LIMIT_MAX, 5),
    window: process.env.PUBLIC_RATE_LIMIT_WINDOW || '10 minutes',
  },
};

/* Nombre de cookie que corresponde a un realm. Si el realm no esta en el mapa
   se cae al nombre heredado (tn_sid). */
function cookieNameFor(realm) {
  if (realm && config.cookie.names && config.cookie.names[realm]) return config.cookie.names[realm];
  return config.cookie.name;
}

function assertConfig() {
  const missing = [];
  if (!config.jwt.secret) missing.push('JWT_SECRET');
  if (!config.cookie.secret) missing.push('COOKIE_SECRET');
  if (!config.db.connectionString) missing.push('DATABASE_URL');
  if (isProduction && !config.cors.origins.length) missing.push('CORS_ORIGINS');
  /* Fail-closed: sin clave de cifrado no arranca en produccion. Asi ningun
     despliegue puede guardar datos sensibles en claro por olvido. */
  if (isProduction && !config.encryption.key) missing.push('DATA_ENCRYPTION_KEY');
  if (missing.length) {
    throw new Error(`Faltan variables de entorno obligatorias: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertConfig, cookieNameFor };
