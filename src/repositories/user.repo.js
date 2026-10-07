'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextUserId(client) {
  const { rows } = await runner(client).query("SELECT nextval('user_number_seq') AS n");
  return ids.userId(Number(rows[0].n));
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO users
       (user_id, email, name, role, status, permissions, username, phone,
        department_id, desk_id, manager_id, visible_desk_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      data.userId,
      data.email,
      data.name,
      data.role,
      data.status || 'active',
      data.permissions || [],
      data.username || null,
      data.phone || null,
      data.departmentId || null,
      data.deskId || null,
      data.managerId || null,
      data.visibleDeskIds || [],
    ]
  );
  return rows[0];
}

async function findById(userId, client) {
  const { rows } = await runner(client).query('SELECT * FROM users WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function findByEmail(email, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

async function findByUsername(username, client) {
  if (!username) return null;
  const { rows } = await runner(client).query(
    'SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1',
    [username]
  );
  return rows[0] || null;
}

async function list(client) {
  const { rows } = await runner(client).query('SELECT * FROM users ORDER BY created_at ASC');
  return rows;
}

const UPDATABLE = {
  name: 'name',
  email: 'email',
  username: 'username',
  phone: 'phone',
  role: 'role',
  status: 'status',
  departmentId: 'department_id',
  deskId: 'desk_id',
  managerId: 'manager_id',
  visibleDeskIds: 'visible_desk_ids',
};

async function update(userId, changes, client) {
  const sets = [];
  const values = [userId];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(userId, client);
  const { rows } = await runner(client).query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function remove(userId, client) {
  const { rowCount } = await runner(client).query('DELETE FROM users WHERE user_id = $1', [userId]);
  return rowCount > 0;
}

async function touchLogin(userId, client) {
  await runner(client).query('UPDATE users SET last_login = now() WHERE user_id = $1', [userId]);
}

module.exports = {
  nextUserId,
  insert,
  findById,
  findByEmail,
  findByUsername,
  list,
  update,
  remove,
  touchLogin,
};
