'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

/* Traduce el nombre en camelCase que usa el CRM a la columna real. Solo se
   admiten las claves listadas: cualquier otra se ignora (evita inyección). */
const COLUMNS = {
  departments: { key: 'key', name: 'name', active: 'active' },
  roles: { name: 'name', description: 'description', perms: 'perms' },
  desks: {
    name: 'name',
    departmentId: 'department_id',
    managerId: 'manager_id',
    memberIds: 'member_ids',
    viewerIds: 'viewer_ids',
    active: 'active',
  },
  lead_statuses: { label: 'label', tone: 'tone', order: 'sort_order', active: 'active' },
};

function mapped(table, data) {
  const map = COLUMNS[table] || {};
  const out = {};
  for (const key of Object.keys(map)) {
    if (data[key] !== undefined) out[map[key]] = data[key];
  }
  return out;
}

async function updateRow(table, id, data, client) {
  const fields = mapped(table, data);
  const columns = Object.keys(fields);
  if (!columns.length) return findRow(table, id, client);
  const sets = columns.map((column, index) => `${column} = $${index + 2}`);
  const params = [id, ...columns.map((column) => fields[column])];
  const { rows } = await runner(client).query(
    `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function findRow(table, id, client) {
  const { rows } = await runner(client).query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function deleteRow(table, id, client) {
  const { rowCount } = await runner(client).query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ------------------------------- departamentos ------------------------------
async function listDepartments(client) {
  const { rows } = await runner(client).query('SELECT * FROM departments ORDER BY name ASC');
  return rows;
}

async function findDepartment(id, client) {
  return findRow('departments', id, client);
}

async function insertDepartment(data, client) {
  const { rows } = await runner(client).query(
    'INSERT INTO departments (id, key, name, active) VALUES ($1,$2,$3,$4) RETURNING *',
    [data.id, data.key || data.id, data.name, data.active !== false]
  );
  return rows[0];
}

async function updateDepartment(id, data, client) {
  return updateRow('departments', id, data, client);
}

async function deleteDepartment(id, client) {
  return deleteRow('departments', id, client);
}

// ---------------------------------- roles -----------------------------------
async function listRoles(client) {
  const { rows } = await runner(client).query('SELECT * FROM roles ORDER BY name ASC');
  return rows;
}

async function findRole(id, client) {
  return findRow('roles', id, client);
}

async function insertRole(data, client) {
  const { rows } = await runner(client).query(
    'INSERT INTO roles (id, name, description, perms) VALUES ($1,$2,$3,$4) RETURNING *',
    [data.id, data.name, data.description || null, data.perms || []]
  );
  return rows[0];
}

async function updateRole(id, data, client) {
  return updateRow('roles', id, data, client);
}

async function deleteRole(id, client) {
  return deleteRow('roles', id, client);
}

// ---------------------------------- desks -----------------------------------
async function listDesks(client) {
  const { rows } = await runner(client).query('SELECT * FROM desks ORDER BY name ASC');
  return rows;
}

async function findDesk(id, client) {
  return findRow('desks', id, client);
}

async function insertDesk(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO desks (id, name, department_id, manager_id, member_ids, viewer_ids, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      data.id,
      data.name,
      data.departmentId || null,
      data.managerId || null,
      data.memberIds || [],
      data.viewerIds || [],
      data.active !== false,
    ]
  );
  return rows[0];
}

async function updateDesk(id, data, client) {
  return updateRow('desks', id, data, client);
}

async function deleteDesk(id, client) {
  return deleteRow('desks', id, client);
}

// ------------------------------ estados de lead -----------------------------
async function listLeadStatuses(client) {
  const { rows } = await runner(client).query('SELECT * FROM lead_statuses ORDER BY sort_order ASC');
  return rows;
}

async function findLeadStatus(id, client) {
  return findRow('lead_statuses', id, client);
}

async function insertLeadStatus(data, client) {
  const { rows } = await runner(client).query(
    'INSERT INTO lead_statuses (id, label, tone, sort_order, active) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [data.id, data.label, data.tone || 'neutral', data.order || 1, data.active !== false]
  );
  return rows[0];
}

async function updateLeadStatus(id, data, client) {
  return updateRow('lead_statuses', id, data, client);
}

async function deleteLeadStatus(id, client) {
  return deleteRow('lead_statuses', id, client);
}

// ---------------------------------- notas -----------------------------------
async function listNotes({ entityType, entityId, limit } = {}, client) {
  const params = [];
  const clauses = [];
  if (entityType) {
    params.push(entityType);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    clauses.push(`entity_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 1000));
  const { rows } = await runner(client).query(
    `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function insertNote(data, client) {
  const { rows } = await runner(client).query(
    'INSERT INTO notes (id, entity_type, entity_id, text, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [data.id, data.entityType, data.entityId, data.text, data.userId || null]
  );
  return rows[0];
}

module.exports = {
  listDepartments,
  findDepartment,
  insertDepartment,
  updateDepartment,
  deleteDepartment,
  listRoles,
  findRole,
  insertRole,
  updateRole,
  deleteRole,
  listDesks,
  findDesk,
  insertDesk,
  updateDesk,
  deleteDesk,
  listLeadStatuses,
  findLeadStatus,
  insertLeadStatus,
  updateLeadStatus,
  deleteLeadStatus,
  listNotes,
  insertNote,
};
