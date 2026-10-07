'use strict';

const { config } = require('../lib/config');
const { AppError } = require('../lib/errors');
const csrf = require('../lib/csrf');
const { extractToken } = require('./auth');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/* Endpoints publicos sin sesion (formulario de captacion). Se eximen para que
   una visita con cookie de otro realm no rompa el alta anonima. */
const EXEMPT_PREFIXES = ['/api/public'];

/* Exige la cabecera CSRF en cualquier peticion mutante que ya lleve sesion
   (cookie propia del realm o Bearer). Las rutas publicas sin sesion (alta,
   login, formulario de leads) no se ven afectadas porque no traen sesion. */
async function csrfGuard(request) {
  if (!config.csrf.enabled) return;
  if (SAFE_METHODS.has(request.method)) return;

  const path = String(request.url || '').split('?')[0];
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return;

  const token = extractToken(request);
  if (!token) return;

  const cookies = request.cookies || {};
  const cookieValue = cookies[config.csrf.cookieName] || '';
  const headerValue = request.headers[config.csrf.headerName] || '';

  if (!cookieValue || !headerValue || !csrf.timingEqual(headerValue, cookieValue)) {
    throw AppError.forbidden('Token CSRF ausente o invalido');
  }
}

module.exports = { csrfGuard };
