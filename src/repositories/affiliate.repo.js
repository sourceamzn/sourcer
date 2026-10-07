'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextAffiliateId(client) {
  const { rows } = await runner(client).query("SELECT nextval('affiliate_number_seq') AS n");
  return ids.affiliateId(Number(rows[0].n));
}

async function nextConversionId(client) {
  const { rows } = await runner(client).query("SELECT nextval('affiliate_conversion_number_seq') AS n");
  return ids.conversionId(Number(rows[0].n));
}

async function insertAffiliate(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO affiliates
       (affiliate_id, code, name, email, company, status, commission_type, commission_value, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      data.affiliateId,
      data.code,
      data.name,
      data.email || null,
      data.company || null,
      data.status || 'active',
      data.commissionType || 'cpa',
      data.commissionValue || 0,
      data.notes || null,
    ]
  );
  return rows[0];
}

async function findById(affiliateId, client) {
  const { rows } = await runner(client).query('SELECT * FROM affiliates WHERE affiliate_id = $1', [affiliateId]);
  return rows[0] || null;
}

async function findByCode(code, client) {
  if (!code) return null;
  const { rows } = await runner(client).query(
    'SELECT * FROM affiliates WHERE lower(code) = lower($1) LIMIT 1',
    [code]
  );
  return rows[0] || null;
}

const UPDATABLE = {
  name: 'name',
  email: 'email',
  company: 'company',
  status: 'status',
  commissionType: 'commission_type',
  commissionValue: 'commission_value',
  notes: 'notes',
};

async function update(affiliateId, changes, client) {
  const sets = [];
  const values = [affiliateId];
  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (changes[key] !== undefined) {
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return findById(affiliateId, client);
  const { rows } = await runner(client).query(
    `UPDATE affiliates SET ${sets.join(', ')}, updated_at = now() WHERE affiliate_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function insertConversion(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO affiliate_conversions
       (conversion_id, affiliate_id, lead_id, client_id, type, amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      data.conversionId,
      data.affiliateId,
      data.leadId || null,
      data.clientId || null,
      data.type || 'lead',
      data.amount || 0,
      data.status || 'pending',
    ]
  );
  return rows[0];
}

/* Listado con contadores agregados por afiliado. Evita una consulta por fila. */
async function listWithStats({ limit, offset, status }, client) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE a.status = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT a.*,
            COALESCE(c.leads, 0)::int     AS leads,
            COALESCE(c.accounts, 0)::int  AS accounts,
            COALESCE(c.deposits, 0)::int  AS deposits,
            COALESCE(t.commission, 0)     AS commission
       FROM affiliates a
       LEFT JOIN (
         SELECT affiliate_id,
                COUNT(*) FILTER (WHERE type = 'lead')    AS leads,
                COUNT(*) FILTER (WHERE type = 'account') AS accounts,
                COUNT(*) FILTER (WHERE type = 'deposit') AS deposits
           FROM affiliate_conversions
          GROUP BY affiliate_id
       ) c ON c.affiliate_id = a.affiliate_id
       LEFT JOIN (
         SELECT affiliate_id, SUM(amount) FILTER (WHERE status IN ('approved','paid')) AS commission
           FROM affiliate_conversions
          GROUP BY affiliate_id
       ) t ON t.affiliate_id = a.affiliate_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function count({ status }, client) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  const { rows } = await runner(client).query(`SELECT COUNT(*)::int AS total FROM affiliates ${where}`, params);
  return rows[0].total;
}

async function findConversionByLead(affiliateId, leadId, client) {
  const { rows } = await runner(client).query(
    `SELECT * FROM affiliate_conversions
      WHERE affiliate_id = $1 AND lead_id = $2 AND type = 'lead' LIMIT 1`,
    [affiliateId, leadId]
  );
  return rows[0] || null;
}

async function listConversions({ affiliateId, limit, offset }, client) {
  const params = [affiliateId];
  const { rows } = await runner(client).query(
    `SELECT * FROM affiliate_conversions
      WHERE affiliate_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [affiliateId, limit, offset]
  );
  return rows;
}

module.exports = {
  nextAffiliateId,
  nextConversionId,
  insertAffiliate,
  findById,
  findByCode,
  update,
  insertConversion,
  listWithStats,
  count,
  findConversionByLead,
  listConversions,
};
