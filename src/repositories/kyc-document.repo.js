'use strict';

const db = require('../db');
const ids = require('../lib/ids');
const crypto = require('../lib/crypto');

/* La nota de revision puede contener datos personales/financieros, asi que se
   guarda cifrada. El contenido binario del documento se cifra aparte con
   encryptBuffer/decryptBuffer antes de tocar la base de datos. */
const ENCRYPTED_FIELDS = ['note'];

/* Nunca se selecciona content_enc en listados: es un BLOB cifrado y traerlo en
   cada fila inflaria la respuesta y la memoria. Solo getContent lo lee. */
const LIST_COLUMNS =
  'id, client_id, type, name, status, note, uploaded_at, reviewed_at, reviewed_by, created_at, updated_at, content_mime, content_size, content_sha256';

function runner(client) {
  return client || db.pool;
}

function decryptRow(row) {
  return crypto.decryptFields(row, ENCRYPTED_FIELDS);
}

function decryptRows(rows) {
  return rows.map(decryptRow);
}

async function nextDocumentId(client) {
  const { rows } = await runner(client).query("SELECT nextval('kyc_document_number_seq') AS n");
  return ids.kycDocumentId(Number(rows[0].n));
}

async function insert(data, client) {
  const note = data.note ? crypto.encrypt(data.note) : null;
  const { rows } = await runner(client).query(
    `INSERT INTO kyc_documents
       (id, client_id, type, name, status, note, uploaded_at, reviewed_at, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9)
     RETURNING ${LIST_COLUMNS}`,
    [
      data.id,
      data.clientId,
      data.type,
      data.name,
      data.status || 'received',
      note,
      data.uploadedAt || null,
      data.reviewedAt || null,
      data.reviewedBy || null,
    ]
  );
  return decryptRow(rows[0]);
}

async function findById(id, client) {
  const { rows } = await runner(client).query(
    `SELECT ${LIST_COLUMNS} FROM kyc_documents WHERE id = $1`,
    [id]
  );
  return decryptRow(rows[0] || null);
}

async function listByClient(clientId, client) {
  const { rows } = await runner(client).query(
    `SELECT ${LIST_COLUMNS} FROM kyc_documents WHERE client_id = $1 ORDER BY uploaded_at DESC, created_at DESC`,
    [clientId]
  );
  return decryptRows(rows);
}

/* Guarda el contenido cifrado de un documento. El cifrado ocurre en la capa
   de servicio (crypto.encryptBuffer) y aqui solo se persiste el blob. */
async function setContent(id, { content, mime, size, sha256 }, client) {
  const { rows } = await runner(client).query(
    `UPDATE kyc_documents
        SET content_enc = $2, content_mime = $3, content_size = $4, content_sha256 = $5, updated_at = now()
      WHERE id = $1
      RETURNING id, client_id, type, name, status, content_mime, content_size, content_sha256, uploaded_at, created_at`,
    [id, content, mime || null, size || null, sha256 || null]
  );
  return rows[0] || null;
}

async function getContent(id, client) {
  const { rows } = await runner(client).query(
    'SELECT id, client_id, name, content_enc, content_mime, content_size, content_sha256 FROM kyc_documents WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function list({ limit, offset, clientId } = {}, client) {
  const params = [];
  let where = '';
  if (clientId) {
    params.push(clientId);
    where = `WHERE client_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT ${LIST_COLUMNS} FROM kyc_documents ${where}
      ORDER BY uploaded_at DESC, created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return decryptRows(rows);
}

const UPDATABLE = {
  name: 'name',
  type: 'type',
  status: 'status',
  note: 'note',
  reviewedBy: 'reviewed_by',
  reviewedAt: 'reviewed_at',
};

async function update(id, changes, client) {
  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      const value = key === 'note' && changes[key] ? crypto.encrypt(changes[key]) : changes[key];
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(id, client);
  const { rows } = await runner(client).query(
    `UPDATE kyc_documents SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${LIST_COLUMNS}`,
    values
  );
  return decryptRow(rows[0] || null);
}

async function remove(id, client) {
  const { rowCount } = await runner(client).query('DELETE FROM kyc_documents WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { nextDocumentId, insert, findById, listByClient, list, update, remove, setContent, getContent };
