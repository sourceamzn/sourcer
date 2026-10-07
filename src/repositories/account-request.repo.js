'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextRequestId(client) {
  const { rows } = await runner(client).query("SELECT nextval('account_request_number_seq') AS n");
  return ids.requestId(Number(rows[0].n));
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO account_requests
       (request_id, client_id, account_type_id, currency, status,
        requested_by_type, requested_by_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.requestId,
      data.clientId,
      data.accountTypeId,
      data.currency || 'EUR',
      data.status || 'received',
      data.requestedByType,
      data.requestedById || null,
      data.notes || null,
    ]
  );
  return rows[0];
}

async function findById(requestId, client, { forUpdate = false } = {}) {
  const { rows } = await runner(client).query(
    `SELECT * FROM account_requests WHERE request_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [requestId]
  );
  return rows[0] || null;
}

async function listByClient(clientId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM account_requests WHERE client_id = $1 ORDER BY created_at DESC',
    [clientId]
  );
  return rows;
}

async function list({ statuses, limit, offset } = {}, client) {
  const params = [];
  const where = [];
  if (statuses && statuses.length) {
    params.push(statuses);
    where.push(`ar.status = ANY($${params.length})`);
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT ar.*,
            c.first_name, c.last_name, c.email AS client_email
       FROM account_requests ar
       LEFT JOIN clients c ON c.client_id = ar.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ar.created_at ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function count({ statuses } = {}, client) {
  const params = [];
  let where = '';
  if (statuses && statuses.length) {
    params.push(statuses);
    where = `WHERE ar.status = ANY($1)`;
  }
  const { rows } = await runner(client).query(
    `SELECT COUNT(*)::int AS total FROM account_requests ar ${where}`,
    params
  );
  return rows[0].total;
}

async function findOpenByClient(clientId, client) {
  const { rows } = await runner(client).query(
    `SELECT * FROM account_requests
      WHERE client_id = $1 AND status IN ('received','in_review')
      LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

async function hasProvisionedByClient(clientId, client) {
  const { rows } = await runner(client).query(
    `SELECT 1 FROM account_requests WHERE client_id = $1 AND status = 'provisioned' LIMIT 1`,
    [clientId]
  );
  return rows.length > 0;
}

async function markProvisioned(requestId, accountId, decidedById, client) {
  const { rows } = await runner(client).query(
    `UPDATE account_requests
        SET status = 'provisioned', provisioned_account_id = $2,
            decided_at = now(), decided_by_id = $3
      WHERE request_id = $1
      RETURNING *`,
    [requestId, accountId, decidedById]
  );
  return rows[0] || null;
}

async function markRejected(requestId, decidedById, notes, client) {
  const { rows } = await runner(client).query(
    `UPDATE account_requests
        SET status = 'rejected', decided_at = now(), decided_by_id = $2,
            notes = COALESCE($3, notes)
      WHERE request_id = $1
      RETURNING *`,
    [requestId, decidedById, notes || null]
  );
  return rows[0] || null;
}

async function markInReview(requestId, client) {
  const { rows } = await runner(client).query(
    `UPDATE account_requests SET status = 'in_review' WHERE request_id = $1 RETURNING *`,
    [requestId]
  );
  return rows[0] || null;
}

module.exports = {
  nextRequestId,
  insert,
  findById,
  listByClient,
  list,
  count,
  findOpenByClient,
  hasProvisionedByClient,
  markProvisioned,
  markRejected,
  markInReview,
};
