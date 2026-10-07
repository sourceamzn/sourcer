'use strict';

const nodeCrypto = require('node:crypto');
const clients = require('../repositories/client.repo');
const docs = require('../repositories/kyc-document.repo');
const audit = require('../repositories/audit.repo');
const serialize = require('../domain/serialize');
const crypto = require('../lib/crypto');
const { AppError } = require('../lib/errors');

const TYPES = ['selfie', 'id', 'source_funds', 'proof_address'];
const STATUSES = ['received', 'approved', 'rejected'];

/* El contenido de los documentos es material no confiable: se limita el tamano,
   se restringe el tipo MIME y NUNCA se ejecuta ni se sirve inline. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const TYPE_NAMES = {
  id: 'Documento de identidad',
  selfie: 'Selfie / prueba de vida',
  source_funds: 'Origen de los fondos',
  proof_address: 'Justificante de domicilio',
};

function defaultName(type) {
  return `${TYPE_NAMES[type] || type}.pdf`;
}

async function assertClient(clientId) {
  const row = await clients.findById(clientId);
  if (!row) throw AppError.notFound('Cliente no encontrado');
  return row;
}

/* Documentos de un cliente (ficha de cliente del CRM). */
async function listClientDocuments(clientId) {
  await assertClient(clientId);
  return (await docs.listByClient(clientId)).map(serialize.toKycDocument);
}

/* Todos los documentos (seccion Documentos y verificacion KYC del CRM). */
async function listDocuments(query = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 500, 1), 1000);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  const clientId = query.clientId ? String(query.clientId) : null;
  const rows = await docs.list({ limit, offset, clientId });
  return { items: rows.map(serialize.toKycDocument) };
}

async function createDocument(clientId, input, actor) {
  await assertClient(clientId);
  if (TYPES.indexOf(input.type) < 0) {
    throw AppError.validation('Tipo de documento no valido');
  }
  const status = STATUSES.indexOf(input.status) >= 0 ? input.status : 'received';
  const id = await docs.nextDocumentId();
  const row = await docs.insert({
    id,
    clientId,
    type: input.type,
    name: (input.name && String(input.name).trim()) || defaultName(input.type),
    status,
    note: input.note,
    reviewedBy: status === 'received' ? null : actor.id,
    reviewedAt: status === 'received' ? null : new Date(),
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'kyc.document.create',
    object: id,
    details: { clientId, type: input.type, status },
  });
  return serialize.toKycDocument(row);
}

async function reviewDocument(docId, input, actor) {
  const existing = await docs.findById(docId);
  if (!existing) throw AppError.notFound('Documento no encontrado');
  if (STATUSES.indexOf(input.status) < 0) {
    throw AppError.validation('Estado de documento no valido');
  }
  const row = await docs.update(docId, {
    status: input.status,
    note: input.note !== undefined ? input.note : undefined,
    reviewedBy: actor.id,
    reviewedAt: new Date(),
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'kyc.document.review',
    object: docId,
    details: { clientId: existing.client_id, status: input.status },
  });
  return serialize.toKycDocument(row);
}

async function deleteDocument(docId, actor) {
  const existing = await docs.findById(docId);
  if (!existing) throw AppError.notFound('Documento no encontrado');
  await docs.remove(docId);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'kyc.document.delete',
    object: docId,
    details: { clientId: existing.client_id },
  });
  return { ok: true, id: docId };
}

/* Guarda el contenido (base64) de un documento cifrado en reposo. */
async function uploadDocumentContent(docId, input, actor) {
  const existing = await docs.findById(docId);
  if (!existing) throw AppError.notFound('Documento no encontrado');

  const mime = String(input.mime || '').toLowerCase();
  if (ALLOWED_MIME.indexOf(mime) < 0) {
    throw AppError.validation('Tipo de archivo no permitido (use PDF, JPG, PNG, WEBP o HEIC)');
  }
  let buffer;
  try {
    buffer = Buffer.from(String(input.contentBase64 || ''), 'base64');
  } catch (err) {
    throw AppError.validation('Contenido no valido');
  }
  if (!buffer.length) throw AppError.validation('El documento esta vacio');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw AppError.validation('El documento supera el limite de 10 MB');
  }

  const sha256 = nodeCrypto.createHash('sha256').update(buffer).digest('hex');
  const encrypted = crypto.encryptBuffer(buffer);
  await docs.setContent(docId, { content: encrypted, mime, size: buffer.length, sha256 });

  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'kyc.document.content.upload',
    object: docId,
    details: { clientId: existing.client_id, type: existing.type, size: buffer.length, sha256 },
  });

  return { id: docId, mime, size: buffer.length, sha256 };
}

/* Devuelve el contenido descifrado (base64). Solo para personal autorizado. */
async function getDocumentContent(docId, actor) {
  const row = await docs.getContent(docId);
  if (!row) throw AppError.notFound('Documento no encontrado');
  if (!row.content_enc) throw AppError.notFound('El documento no tiene contenido adjunto');

  const buffer = crypto.decryptBuffer(row.content_enc);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'kyc.document.content.read',
    object: docId,
    details: { clientId: row.client_id },
  });
  return {
    id: docId,
    name: row.name,
    mime: row.content_mime || 'application/octet-stream',
    size: row.content_size || buffer.length,
    sha256: row.content_sha256 || null,
    contentBase64: buffer.toString('base64'),
  };
}

module.exports = {
  listClientDocuments,
  listDocuments,
  createDocument,
  reviewDocument,
  deleteDocument,
  uploadDocumentContent,
  getDocumentContent,
};
