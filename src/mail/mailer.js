'use strict';

const nodemailer = require('nodemailer');
const { config } = require('../lib/config');

let transporter = null;

/* Prioridad de envio:
   1) API HTTPS (Resend) si RESEND_API_KEY esta definido -> funciona en
      Railway Hobby/Free, donde la salida SMTP esta bloqueada.
   2) SMTP clasico (nodemailer) si SMTP_HOST esta definido.
   3) Modo consola (desarrollo): escribe el correo en el log. */
function provider() {
  if (config.resend.apiKey) return 'resend';
  if (config.smtp.host) return 'smtp';
  return 'console';
}

function isConfigured() {
  return provider() !== 'console';
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: config.smtp.timeoutMs,
      greetingTimeout: config.smtp.timeoutMs,
      socketTimeout: config.smtp.timeoutMs,
    });
  }
  return transporter;
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.resend.from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  return { queued: true, via: 'resend' };
}

async function send({ to, subject, text, html }) {
  const mode = provider();

  if (mode === 'resend') {
    return sendViaResend({ to, subject, text, html });
  }

  if (mode === 'smtp') {
    await getTransporter().sendMail({ from: config.smtp.from, to, subject, text, html });
    return { queued: true, via: 'smtp' };
  }

  console.log(`[mail:dev] to=${to} subject=${subject}\n${text || ''}`);
  return { queued: false, dev: true };
}

module.exports = { send, isConfigured, provider };
