'use strict';

const db = require('../db');
const crypto = require('../lib/crypto');

/* Campos que se cifran en reposo: son datos financieros/personales y no se
   consultan por SQL (no hay LIKE/WHERE sobre ellos), asi que pueden vivir
   cifrados sin romper la operativa. */
const ENCRYPTED_FIELDS = ['iban', 'bic', 'beneficiary', 'comment'];

function runner(client) {
  return client || db.pool;
}

function encryptRow(row) {
  return crypto.encryptFields(row, ENCRYPTED_FIELDS);
}

function decryptRow(row) {
  return crypto.decryptFields(row, ENCRYPTED_FIELDS);
}

function decryptRows(rows) {
  return rows.map(decryptRow);
}

async function nextNumber(client) {
  const { rows } = await runner(client).query("SELECT nextval('cash_request_number_seq') AS n");
  return Number(rows[0].n);
}

async function insert(data, client) {
  const row = encryptRow({
    id: data.id,
    clientId: data.clientId,
    accountNumber: data.accountNumber,
    kind: data.kind,
    amount: data.amount,
    currency: data.currency || 'EUR',
    method: data.method || null,
    reference: data.reference || null,
    comment: data.comment || null,
    beneficiary: data.beneficiary || null,
    iban: data.iban || null,
    bic: data.bic || null,
    status: data.status || 'pending',
  });
  const { rows } = await runner(client).query(
    `INSERT INTO cash_requests
       (id, client_id, account_number, kind, amount, currency, method, reference,
        comment, beneficiary, iban, bic, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      row.id,
      row.clientId,
      row.accountNumber,
      row.kind,
      row.amount,
      row.currency,
      row.method,
      row.reference,
      row.comment,
      row.beneficiary,
      row.iban,
      row.bic,
      row.status,
    ]
  );
  return decryptRow(rows[0]);
}

async function findById(id, client) {
  const { rows } = await runner(client).query('SELECT * FROM cash_requests WHERE id = $1', [id]);
  return decryptRow(rows[0] || null);
}

async function listByClient(clientId, kind, client) {
  const params = [clientId];
  let extra = '';
  if (kind) {
    params.push(kind);
    extra = ` AND kind = $${params.length}`;
  }
  const { rows } = await runner(client).query(
    `SELECT * FROM cash_requests WHERE client_id = $1${extra} ORDER BY created_at DESC`,
    params
  );
  return decryptRows(rows);
}

async function list({ status, kind, clientId, limit, offset } = {}, client) {
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`cr.status = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`cr.kind = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    where.push(`cr.client_id = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT cr.*, c.first_name, c.last_name, c.email AS client_email
       FROM cash_requests cr
       LEFT JOIN clients c ON c.client_id = cr.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY cr.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return decryptRows(rows);
}

async function decide(id, { status, transactionId, reviewedBy, notes }, client) {
  const { rows } = await runner(client).query(
    `UPDATE cash_requests
        SET status = $2,
            transaction_id = COALESCE($3, transaction_id),
            reviewed_by = $4,
            reviewed_at = now(),
            notes = COALESCE($5, notes),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, transactionId || null, reviewedBy || null, notes || null]
  );
  return decryptRow(rows[0] || null);
}

module.exports = { nextNumber, insert, findById, listByClient, list, decide };
