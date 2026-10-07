'use strict';

const { config, cookieNameFor } = require('../lib/config');
const { AppError } = require('../lib/errors');
const { verify } = require('../lib/token');
const csrf = require('../lib/csrf');
const authRepo = require('../repositories/auth.repo');

const REALMS = ['client-area', 'crm', 'terminal'];

/* Deduce desde que aplicacion viene la peticion para elegir SU cookie de
   sesion. El robot sirve a varias apps en subdominios distintos del mismo
   dominio; el navegador envia TODAS las cookies de ese dominio, asi que hay
   que saber cual corresponde. Primero se respeta una cabecera explicita
   (X-TN-Realm) y, si no, se infiere del Origin/Referer, que el navegador
   envia siempre en peticiones entre subdominios. */
function realmFromRequest(request) {
  const header = String((request.headers && request.headers['x-tn-realm']) || '').trim().toLowerCase();
  if (REALMS.includes(header)) return header;
  const source = (request.headers && (request.headers.origin || request.headers.referer)) || '';
  if (source) {
    try {
      const host = new URL(source).hostname.toLowerCase();
      if (host.indexOf('client') >= 0) return 'client-area';
      if (host.indexOf('trading') >= 0) return 'client-area';
      if (host.indexOf('manager') >= 0) return 'crm';
      if (host.indexOf('crm') >= 0) return 'crm';
      if (host.indexOf('terminal') >= 0) return 'terminal';
    } catch (err) {
      /* origen no parseable: se resuelve mas abajo */
    }
  }
  return null;
}

function extractToken(request) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookies = request.cookies || {};
  const realm = realmFromRequest(request);
  if (realm) {
    const name = cookieNameFor(realm);
    if (cookies[name]) return cookies[name];
    /* Sesion emitida antes de separar las cookies por realm. */
    if (cookies[config.cookie.name]) return cookies[config.cookie.name];
    return null;
  }
  /* Sin realm identificable se prioriza el menos privilegiado para no elevar
     permisos por error, y se deja el nombre heredado al final. */
  const order = ['client-area', 'terminal', 'crm'];
  for (let i = 0; i < order.length; i += 1) {
    const name = cookieNameFor(order[i]);
    if (cookies[name]) return cookies[name];
  }
  if (cookies[config.cookie.name]) return cookies[config.cookie.name];
  return null;
}

async function authenticate(request, reply) {
  const token = extractToken(request);
  if (!token) throw AppError.unauthorized();

  const claims = verify(token);
  const session = await authRepo.findSession(claims.jti);
  if (!session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
    throw AppError.unauthorized('Sesion expirada o revocada');
  }

  /* Autocura del token CSRF: cualquier peticion autenticada (p. ej. el GET
     inicial de una app) emite la cookie CSRF si aun no existe, de modo que las
     escrituras posteriores puedan reenviarla en X-CSRF-Token. */
  if (reply && config.csrf.enabled) {
    const cookies = request.cookies || {};
    if (!cookies[config.csrf.cookieName]) {
      reply.setCookie(config.csrf.cookieName, csrf.newToken(), csrf.cookieOptions());
    }
  }

  request.actor = {
    type: claims.actorType,
    id: claims.actorId,
    realm: claims.realm,
    clientId: claims.clientId || null,
    role: claims.role || null,
    permissions: claims.permissions || [],
    jti: claims.jti,
  };
}

module.exports = { authenticate, extractToken };
