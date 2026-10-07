'use strict';

const { z } = require('zod');
const { config, cookieNameFor } = require('../lib/config');
const { validate } = require('../middleware/validate');
const csrf = require('../lib/csrf');
const auth = require('../services/auth.service');

const registerSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  phone: z.string().max(40).optional(),
  country: z.string().max(80).optional(),
});

/* El identificador de acceso puede ser el email (clientes) o el nombre de
   usuario (empleados del CRM), así que no se exige formato de email. */
const loginSchema = z.object({
  email: z.string().min(1).max(160),
  password: z.string().min(1),
  realm: z.enum(['client-area', 'crm', 'terminal']).optional(),
});

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) });
const verifySchema = z.object({ token: z.string().min(10) });

function sessionCookie() {
  return {
    path: '/',
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
  };
}

/* Limite de autenticacion configurable. Por defecto es estricto (20/min por
   IP) para frenar la fuerza bruta; se puede ajustar o desactivar con
   AUTH_RATE_LIMIT_ENABLED / AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW. */
function authRateLimitConfig() {
  if (!config.authRateLimit.enabled) return { rateLimit: false };
  return { rateLimit: { max: config.authRateLimit.max, timeWindow: config.authRateLimit.window } };
}

/* Emite (o reutiliza) la cookie CSRF por doble envio y devuelve su valor para
   que el frontend pueda reenviarlo en la cabecera X-CSRF-Token. */
function issueCsrf(request, reply) {
  if (!config.csrf.enabled) return null;
  const existing = (request.cookies && request.cookies[config.csrf.cookieName]) || null;
  const value = existing || csrf.newToken();
  reply.setCookie(config.csrf.cookieName, value, csrf.cookieOptions());
  return value;
}

module.exports = async function authRoutes(app) {
  app.post(
    '/auth/register',
    { preHandler: [validate({ body: registerSchema })], config: authRateLimitConfig() },
    async (request, reply) => reply.code(201).send(await auth.register(request.body))
  );

  app.post(
    '/auth/login',
    { preHandler: [validate({ body: loginSchema })], config: authRateLimitConfig() },
    async (request, reply) => {
      const result = await auth.login(request.body);
      const maxAge = Math.max(Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000), 0);
      const realm = (result.actor && result.actor.realm) || request.body.realm || 'client-area';
      /* Cookie propia del realm: asi entrar en una app no cierra la sesion de
         las otras (Client Area, CRM y Manager comparten dominio). */
      reply.setCookie(cookieNameFor(realm), result.token, { ...sessionCookie(), maxAge });
      /* Retira la cookie antigua compartida si aun existia. */
      if (config.cookie.name !== cookieNameFor(realm)) {
        reply.clearCookie(config.cookie.name, sessionCookie());
      }
      const csrfToken = issueCsrf(request, reply);
      /* El token de sesion NO se devuelve en el cuerpo (salvo transicion
         explicita): vive en la cookie HttpOnly y asi no queda expuesto a XSS. */
      const payload = config.security.bodyToken
        ? { ...result, csrfToken }
        : { expiresAt: result.expiresAt, actor: result.actor, csrfToken };
      return reply.send(payload);
    }
  );

  app.post('/auth/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    await auth.logout(request.actor);
    reply.clearCookie(cookieNameFor(request.actor && request.actor.realm), sessionCookie());
    reply.clearCookie(config.cookie.name, sessionCookie());
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    const me = await auth.me(request.actor);
    const csrfToken = issueCsrf(request, reply);
    return { ...me, csrfToken };
  });

  app.post(
    '/auth/password/forgot',
    { preHandler: [validate({ body: forgotSchema })], config: authRateLimitConfig() },
    async (request) => auth.forgotPassword(request.body)
  );

  app.post(
    '/auth/password/reset',
    { preHandler: [validate({ body: resetSchema })], config: authRateLimitConfig() },
    async (request) => auth.resetPassword(request.body)
  );

  app.post(
    '/auth/password/change',
    { preHandler: [app.authenticate, validate({ body: changeSchema })] },
    async (request) => auth.changePassword(request.actor, request.body)
  );

  app.post(
    '/auth/email/verify',
    { preHandler: [validate({ body: verifySchema })] },
    async (request) => auth.verifyEmail(request.body)
  );
};
