'use strict';

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const cookie = require('@fastify/cookie');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const { config } = require('./lib/config');
const { errorHandler } = require('./middleware/error-handler');
const { authenticate } = require('./middleware/auth');
const { csrfGuard } = require('./middleware/csrf');
const registerRoutes = require('./routes');

/* Dominios propios que se aceptan siempre, ademas de CORS_ORIGINS. Evita que
   un subdominio (por ejemplo clientarea) quede bloqueado por CORS si la lista
   de variables de entorno esta incompleta. */
const OWN_DOMAINS = ['toolsnexora.world', 'whselfinvests.com'];

function originAllowed(origin) {
  if (!origin) return true;
  const allowed = config.cors.origins;
  if (!allowed.length) return true;
  if (allowed.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return OWN_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch (err) {
    return false;
  }
}

async function buildApp() {
  const app = Fastify({
    logger: { level: config.isProduction ? 'info' : 'debug' },
    trustProxy: config.security.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler(errorHandler);

  /* Cabeceras de seguridad. La API solo devuelve JSON, por lo que se activa una
     CSP estricta (default-src 'none') como defensa en profundidad frente a XSS
     y a la incrustación de respuestas. Ademas de las cabeceras por defecto de
     helmet (X-Content-Type-Options: nosniff, X-Frame-Options, HSTS, etc.). */
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  await app.register(cookie, { secret: config.cookie.secret });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, originAllowed(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.window,
  });

  app.decorate('authenticate', authenticate);

  /* Defensa CSRF por doble envio para toda peticion mutante con sesion. */
  app.addHook('preHandler', csrfGuard);

  await app.register(registerRoutes, { prefix: '/api' });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } });
  });

  return app;
}

module.exports = { buildApp };
