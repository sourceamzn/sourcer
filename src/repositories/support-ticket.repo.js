'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

async function nextNumber(client) {
  const { rows } = await runner(client).query("SELECT nextval('support_ticket_number_seq') AS n");
  return Number(rows[0].n);
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO support_tickets
       (id, client_id, account_number, subject, category, priority, status, messages)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING *`,
    [
      data.id,
      data.clientId,
      data.accountNumber == null ? null : data.accountNumber,
      data.subject,
      data.category || 'other',
      data.priority || 'normal',
      data.status || 'open',
      JSON.stringify(data.messages || []),
    ]
  );
  return rows[0];
}

async function findById(id, client) {
  const { rows } = await runner(client).query('SELECT * FROM support_tickets WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listByClient(clientId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM support_tickets WHERE client_id = $1 ORDER BY updated_at DESC',
    [clientId]
  );
  return rows;
}

async function list({ status, clientId, limit, offset } = {}, client) {
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    where.push(`t.client_id = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT t.*, c.first_name, c.last_name, c.email AS client_email
       FROM support_tickets t
       LEFT JOIN clients c ON c.client_id = t.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function appendMessage(id, message, status, client) {
  const { rows } = await runner(client).query(
    `UPDATE support_tickets
        SET messages = messages || $2::jsonb,
            status = COALESCE($3, status),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, JSON.stringify([message]), status || null]
  );
  return rows[0] || null;
}

async function setStatus(id, status, client) {
  const { rows } = await runner(client).query(
    'UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { nextNumber, insert, findById, listByClient, list, appendMessage, setStatus };
