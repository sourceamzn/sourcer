'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextClientId(client) {
  const { rows } = await runner(client).query("SELECT nextval('client_number_seq') AS n");
  return ids.clientId(Number(rows[0].n));
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO clients
       (client_id, first_name, last_name, email, phone, country, age, description,
        status, kyc_status, source, campaign_id, campaign, agent_id, manager_id,
        desk_id, lead_id, converted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      data.clientId,
      data.firstName,
      data.lastName,
      data.email,
      data.phone || null,
      data.country || null,
      data.age || null,
      data.description || null,
      data.status || 'active',
      data.kycStatus || 'pending',
      data.source || null,
      data.campaignId || null,
      data.campaign || null,
      data.agentId || null,
      data.managerId || null,
      data.deskId || null,
      data.leadId || null,
      data.convertedAt || null,
    ]
  );
  return rows[0];
}

async function findById(clientId, client) {
  const { rows } = await runner(client).query('SELECT * FROM clients WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

async function findByEmail(email, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM clients WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

const UPDATABLE = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  country: 'country',
  age: 'age',
  description: 'description',
  status: 'status',
  kycStatus: 'kyc_status',
  source: 'source',
  campaignId: 'campaign_id',
  campaign: 'campaign',
  agentId: 'agent_id',
  managerId: 'manager_id',
  deskId: 'desk_id',
};

async function update(clientId, changes, client) {
  const sets = [];
  const values = [clientId];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(clientId, client);
  const { rows } = await runner(client).query(
    `UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE client_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function list({ limit, offset, search }, client) {
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length}
                   OR email ILIKE $${params.length} OR client_id ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT * FROM clients ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function count({ search }, client) {
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR client_id ILIKE $1)`;
  }
  const { rows } = await runner(client).query(`SELECT COUNT(*)::int AS total FROM clients ${where}`, params);
  return rows[0].total;
}

/* Cuenta las entidades dependientes de un cliente antes de borrarlo. Sirve
   para registrar en auditoría qué se destruye con el borrado definitivo. */
async function treeSummary(clientId, client) {
  const { rows } = await runner(client).query(
    `SELECT
       (SELECT COUNT(*)::int FROM trading_accounts WHERE client_id = $1) AS accounts,
       (SELECT COUNT(*)::int FROM leads WHERE client_id = $1)  AS leads,
       (SELECT COUNT(*)::int FROM cash_requests WHERE client_id = $1) AS cash_requests,
       (SELECT COUNT(*)::int FROM support_tickets WHERE client_id = $1) AS support_tickets,
       (SELECT COUNT(*)::int FROM account_requests WHERE client_id = $1) AS account_requests,
       (SELECT COUNT(*)::int FROM kyc_documents WHERE client_id = $1) AS kyc_documents`,
    [clientId]
  );
  return rows[0];
}

/* Borrado definitivo en cascada. La base no declara ON DELETE CASCADE en la
   mayoría de las referencias a clients (solo kyc_documents y, como SET NULL,
   affiliate_conversions), así que el orden lo fija esta función: primero las
   hojas, después las cuentas, y por último el cliente. Todo dentro de la
   transacción que abre el servicio. */
async function removeTree(clientId, client) {
  const q = runner(client);
  const { rows } = await q.query('SELECT number FROM trading_accounts WHERE client_id = $1', [clientId]);
  const numbers = rows.map((r) => r.number);

  if (numbers.length) {
    await q.query('DELETE FROM orders WHERE account_number = ANY($1)', [numbers]);
    await q.query('DELETE FROM positions WHERE account_number = ANY($1)', [numbers]);
    await q.query('DELETE FROM trades WHERE account_number = ANY($1)', [numbers]);
    await q.query('DELETE FROM transactions WHERE account_number = ANY($1)', [numbers]);
  }

  await q.query("DELETE FROM notes WHERE entity_type = 'client' AND entity_id = $1", [clientId]);
  await q.query(
    "DELETE FROM notes WHERE entity_type = 'lead' AND entity_id IN (SELECT lead_id FROM leads WHERE client_id = $1)",
    [clientId]
  );
  await q.query("DELETE FROM crm_tasks WHERE entity_type = 'client' AND entity_id = $1", [clientId]);
  await q.query(
    "DELETE FROM crm_tasks WHERE entity_type = 'lead' AND entity_id IN (SELECT lead_id FROM leads WHERE client_id = $1)",
    [clientId]
  );

  await q.query('DELETE FROM account_requests WHERE client_id = $1', [clientId]);
  await q.query('DELETE FROM cash_requests WHERE client_id = $1', [clientId]);
  await q.query('DELETE FROM support_tickets WHERE client_id = $1', [clientId]);
  await q.query('DELETE FROM leads WHERE client_id = $1', [clientId]);
  await q.query('DELETE FROM trading_accounts WHERE client_id = $1', [clientId]);

  await q.query("DELETE FROM sessions WHERE actor_type = 'client' AND actor_id = $1", [clientId]);
  await q.query("DELETE FROM credentials WHERE subject_type = 'client' AND subject_id = $1", [clientId]);

  const { rowCount } = await q.query('DELETE FROM clients WHERE client_id = $1', [clientId]);
  return rowCount > 0;
}

module.exports = { nextClientId, insert, findById, findByEmail, update, list, count, treeSummary, removeTree };
