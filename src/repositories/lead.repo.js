'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextLeadId(client) {
  const { rows } = await runner(client).query("SELECT nextval('lead_number_seq') AS n");
  return ids.leadId(Number(rows[0].n));
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO leads
       (lead_id, first_name, last_name, phone, email, age, description,
        status_id, agent_id, manager_id, desk_id, campaign_id, campaign, source,
        client_id, country, utm, referral_code, ip_hash, consent_at, import_batch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      data.leadId,
      data.firstName || null,
      data.lastName || null,
      data.phone || null,
      data.email || null,
      data.age || null,
      data.description || null,
      data.statusId || 'st-new',
      data.agentId || null,
      data.managerId || null,
      data.deskId || null,
      data.campaignId || null,
      data.campaign || null,
      data.source || null,
      data.clientId || null,
      data.country || null,
      data.utm ? JSON.stringify(data.utm) : null,
      data.referralCode || null,
      data.ipHash || null,
      data.consentAt || null,
      data.importBatch || null,
    ]
  );
  return rows[0];
}

async function findById(leadId, client) {
  const { rows } = await runner(client).query('SELECT * FROM leads WHERE lead_id = $1', [leadId]);
  return rows[0] || null;
}

/* Busca un lead por correo (sin distinguir mayusculas). Sirve para no duplicar
   a quien rellena el formulario publico mas de una vez. */
async function findByEmail(email, client) {
  if (!email) return null;
  const { rows } = await runner(client).query(
    'SELECT * FROM leads WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

const UPDATABLE = {
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  email: 'email',
  age: 'age',
  description: 'description',
  statusId: 'status_id',
  agentId: 'agent_id',
  managerId: 'manager_id',
  deskId: 'desk_id',
  campaignId: 'campaign_id',
  campaign: 'campaign',
  source: 'source',
  clientId: 'client_id',
  country: 'country',
  referralCode: 'referral_code',
  utm: 'utm',
  ipHash: 'ip_hash',
  consentAt: 'consent_at',
};

async function update(leadId, changes, client) {
  const sets = [];
  const values = [leadId];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(leadId, client);
  const { rows } = await runner(client).query(
    `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE lead_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function remove(leadId, client) {
  await runner(client).query('DELETE FROM notes WHERE entity_type = $1 AND entity_id = $2', ['lead', leadId]);
  const { rowCount } = await runner(client).query('DELETE FROM leads WHERE lead_id = $1', [leadId]);
  return rowCount > 0;
}

/* Borrado definitivo de una selección. Se usa desde el CRM cuando el manager
   marca varios leads (o "seleccionar todo") y confirma el borrado. */
async function removeMany(leadIds, client) {
  if (!leadIds || !leadIds.length) return 0;
  await runner(client).query('DELETE FROM notes WHERE entity_type = $1 AND entity_id = ANY($2)', ['lead', leadIds]);
  const { rowCount } = await runner(client).query('DELETE FROM leads WHERE lead_id = ANY($1)', [leadIds]);
  return rowCount;
}

/* Devuelve el lote de importacion mas reciente (el ultimo grupo de leads
   creado por el importador masivo), para poder deshacer esa subida. */
async function lastImportBatch(client) {
  const { rows } = await runner(client).query(
    `SELECT import_batch AS batch, MAX(created_at) AS at
       FROM leads
      WHERE import_batch IS NOT NULL
      GROUP BY import_batch
      ORDER BY at DESC
      LIMIT 1`
  );
  return rows[0] || null;
}

/* Borrado definitivo de todos los leads de un lote de importacion. */
async function removeByBatch(batch, client) {
  if (!batch) return 0;
  const { rows } = await runner(client).query(
    'SELECT lead_id FROM leads WHERE import_batch = $1',
    [batch]
  );
  const leadIds = rows.map((r) => r.lead_id);
  if (!leadIds.length) return 0;
  await runner(client).query(
    'DELETE FROM notes WHERE entity_type = $1 AND entity_id = ANY($2)',
    ['lead', leadIds]
  );
  const { rowCount } = await runner(client).query('DELETE FROM leads WHERE import_batch = $1', [batch]);
  return rowCount;
}

async function markConverted(leadId, clientId, client) {
  const { rows } = await runner(client).query(
    `UPDATE leads SET status_id = 'st-conv', client_id = $2, updated_at = now()
      WHERE lead_id = $1 RETURNING *`,
    [leadId, clientId]
  );
  return rows[0] || null;
}

function buildWhere({ search, statusId }, params) {
  const clauses = [];
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    clauses.push(
      `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR email ILIKE $${i} OR phone ILIKE $${i} OR lead_id ILIKE $${i})`
    );
  }
  if (statusId) {
    params.push(statusId);
    clauses.push(`status_id = $${params.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

async function list({ limit, offset, search, statusId }, client) {
  const params = [];
  const where = buildWhere({ search, statusId }, params);
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT * FROM leads ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function count({ search, statusId }, client) {
  const params = [];
  const where = buildWhere({ search, statusId }, params);
  const { rows } = await runner(client).query(`SELECT COUNT(*)::int AS total FROM leads ${where}`, params);
  return rows[0].total;
}

/* Clientes que aun no tienen ningun lead asociado: sirve para poblar el CRM
   con las altas que se registraron antes de activar la creacion de leads. */
async function listClientsWithoutLead(client) {
  const { rows } = await runner(client).query(
    `SELECT c.client_id, c.first_name, c.last_name, c.email, c.phone, c.source
       FROM clients c
       LEFT JOIN leads l ON l.client_id = c.client_id
      WHERE l.lead_id IS NULL
      ORDER BY c.created_at ASC`
  );
  return rows;
}

module.exports = {
  nextLeadId,
  insert,
  findById,
  findByEmail,
  update,
  remove,
  removeMany,
  lastImportBatch,
  removeByBatch,
  markConverted,
  list,
  count,
  listClientsWithoutLead,
};
