'use strict';

function verifyEmail({ name, url }) {
  const subject = 'Confirma tu correo - ToolsNexora';
  const text = `Hola ${name || ''},\n\nConfirma tu direccion de correo abriendo este enlace:\n${url}\n\nSi no creaste esta cuenta, ignora este mensaje.`;
  return { subject, text, html: `<p>Hola ${name || ''},</p><p>Confirma tu correo con este enlace:</p><p><a href="${url}">${url}</a></p>` };
}

function passwordReset({ name, url }) {
  const subject = 'Restablece tu contrasena - ToolsNexora';
  const text = `Hola ${name || ''},\n\nRestablece tu contrasena abriendo este enlace (un solo uso):\n${url}\n\nSi no lo solicitaste, ignora este mensaje.`;
  return { subject, text, html: `<p>Hola ${name || ''},</p><p>Restablece tu contrasena con este enlace (un solo uso):</p><p><a href="${url}">${url}</a></p>` };
}

module.exports = { verifyEmail, passwordReset };
