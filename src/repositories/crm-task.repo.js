'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

async function nextNumber(client) {
  const { rows } = await runner(client).query("SELECT nextval('crm_task_number_seq') AS n");
  return Number(rows[0].n);
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO crm_tasks (id, entity_type, entity_id, title, due, status, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      data.id,
      data.entityType || null,
      data.entityId || null,
      data.title,
      data.due || null,
      data.status || 'open',
      data.userId || null,
    ]
  );
  return rows[0];
}

async function findById(id, client) {
  const { rows } = await runner(client).query('SELECT * FROM crm_tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

async function list({ entityType, entityId, status, limit, offset } = {}, client) {
  const params = [];
  const where = [];
  if (entityType) {
    params.push(entityType);
    where.push(`entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    where.push(`entity_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT * FROM crm_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

const UPDATABLE = {
  title: 'title',
  due: 'due',
  status: 'status',
  userId: 'user_id',
  entityType: 'entity_type',
  entityId: 'entity_id',
};

async function update(id, changes, client) {
  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(id, client);
  const { rows } = await runner(client).query(
    `UPDATE crm_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function remove(id, client) {
  const { rowCount } = await runner(client).query('DELETE FROM crm_tasks WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { nextNumber, insert, findById, list, update, remove };
