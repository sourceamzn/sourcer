'use strict';

const crypto = require('node:crypto');
const { config } = require('./config');

/* CSRF por doble envio (double-submit cookie). La cookie NO es HttpOnly para
   que el propio frontend pueda leerla y reenviarla en la cabecera
   X-CSRF-Token; el servidor exige que ambos valores coincidan. Un sitio
   atacante no puede leer la cookie (SameSite + origen cruzado), de modo que
   no puede forjar la cabecera en peticiones mutantes. */
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function cookieOptions() {
  return {
    path: '/',
    httpOnly: false,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
  };
}

module.exports = { newToken, timingEqual, cookieOptions };
