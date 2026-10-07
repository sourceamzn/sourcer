'use strict';

/* Cifrado en reposo (AES-256-GCM) para datos sensibles que NO se buscan por
   SQL (IBAN/BIC, beneficiario, comentarios de solicitudes, notas de KYC y el
   contenido de los documentos subidos). La clave NO vive en la base de datos
   ni en el repositorio: se inyecta por entorno (DATA_ENCRYPTION_KEY) y el
   arranque falla si falta en produccion (fail-closed). Asi, un volcado de la
   base de datos por si solo no revela esos campos. */

const crypto = require('node:crypto');
const { config } = require('./config');

const PREFIX = 'enc.v1';
const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey() {
  const raw = config.encryption && config.encryption.key;
  if (!raw) {
    throw new Error(
      'DATA_ENCRYPTION_KEY no configurada: no se puede cifrar/descifrar datos sensibles'
    );
  }
  const buf = Buffer.from(String(raw).trim(), 'base64');
  if (buf.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY debe ser 32 bytes codificados en base64 (AES-256)');
  }
  return buf;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + ':');
}

/* Cifra texto (o lo devuelve tal cual si esta vacio o ya cifrado). */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const text = String(plain);
  if (isEncrypted(text)) return text;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/* Descifra texto. Acepta valores antiguos en claro (migracion perezosa) y
   lanza si el criptograma fue manipulado (falla de autenticacion GCM). */
function decrypt(payload) {
  if (payload === null || payload === undefined || payload === '') return payload;
  const text = String(payload);
  if (!isEncrypted(text)) return text;
  const parts = text.split(':');
  if (parts.length !== 4) throw new Error('Formato de dato cifrado no valido');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/* Variante binaria para el contenido de documentos. Formato:
   [iv(12)] [tag(16)] [ciphertext]. */
function encryptBuffer(buf) {
  if (buf === null || buf === undefined) return buf;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(buf)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]);
}

function decryptBuffer(buf) {
  if (buf === null || buf === undefined) return buf;
  const raw = Buffer.from(buf);
  if (raw.length < IV_LEN + TAG_LEN) throw new Error('Contenido cifrado no valido');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/* Cifra una lista de columnas de una fila y devuelve una copia. */
function encryptFields(row, fields) {
  if (!row) return row;
  const out = Object.assign({}, row);
  fields.forEach((f) => {
    if (out[f] !== undefined && out[f] !== null && out[f] !== '') out[f] = encrypt(out[f]);
  });
  return out;
}

/* Descifra una lista de columnas de una fila y devuelve una copia. */
function decryptFields(row, fields) {
  if (!row) return row;
  const out = Object.assign({}, row);
  fields.forEach((f) => {
    if (out[f] !== undefined && out[f] !== null && out[f] !== '') out[f] = decrypt(out[f]);
  });
  return out;
}

module.exports = {
  isEncrypted,
  encrypt,
  decrypt,
  encryptBuffer,
  decryptBuffer,
  encryptFields,
  decryptFields,
};
