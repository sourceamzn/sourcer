'use strict';

const db = require('../db');
const affiliates = require('../repositories/affiliate.repo');
const audit = require('../repositories/audit.repo');
const serialize = require('../domain/serialize');
const { AppError } = require('../lib/errors');
const { parsePagination, paginate } = require('../lib/pagination');

/* Convierte un nombre en un codigo de referido legible y seguro para la URL:
   minusculas, sin acentos, solo letras/numeros y guiones. */
function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function uniqueCode(base, client) {
  const seed = slugify(base) || 'afiliado';
  let candidate = seed;
  let n = 2;
  /* eslint no-await-in-loop */
  while (await affiliates.findByCode(candidate, client)) {
    candidate = `${seed}-${n}`;
    n += 1;
  }
  return candidate;
}

async function listAffiliates(query) {
  const { limit, offset } = parsePagination(query);
  const status = query.status || null;
  const rows = await affiliates.listWithStats({ limit, offset, status });
  const total = await affiliates.count({ status });
  return paginate(rows.map(serialize.toAffiliate), limit, offset, total);
}

async function getAffiliate(affiliateId, query = {}) {
  const row = await affiliates.findById(affiliateId);
  if (!row) throw AppError.notFound('Afiliado no encontrado');
  const { limit, offset } = parsePagination(query);
  const conversions = await affiliates.listConversions({ affiliateId, limit, offset });
  return { ...serialize.toAffiliate(row), conversions: conversions.map(serialize.toAffiliateConversion) };
}

async function createAffiliate(input, actor) {
  const code = input.code ? slugify(input.code) : await uniqueCode(input.name);
  const existing = await affiliates.findByCode(code);
  if (existing) throw AppError.conflict('Ya existe un afiliado con ese codigo');
  return db.withTransaction(async (tx) => {
    const affiliateId = await affiliates.nextAffiliateId(tx);
    const row = await affiliates.insertAffiliate(
      {
        affiliateId,
        code,
        name: input.name,
        email: input.email,
        company: input.company,
        status: input.status,
        commissionType: input.commissionType,
        commissionValue: input.commissionValue,
        notes: input.notes,
      },
      tx
    );
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'affiliate.create', object: affiliateId, details: { code } },
      tx
    );
    return serialize.toAffiliate(row);
  });
}

async function updateAffiliate(affiliateId, changes, actor) {
  const existing = await affiliates.findById(affiliateId);
  if (!existing) throw AppError.notFound('Afiliado no encontrado');
  const row = await affiliates.update(affiliateId, changes);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'affiliate.update',
    object: affiliateId,
    details: { fields: Object.keys(changes) },
  });
  return serialize.toAffiliate(row);
}

/* Registra una conversion (lead/account/deposit) para un afiliado. Idempotente
   para las de tipo "lead": si ese lead ya estaba contado, no lo duplica. */
async function recordConversion({ affiliateId, leadId, clientId, type = 'lead', amount = 0, status }, client) {
  if (type === 'lead' && leadId) {
    const already = await affiliates.findConversionByLead(affiliateId, leadId, client);
    if (already) return serialize.toAffiliateConversion(already);
  }
  const conversionId = await affiliates.nextConversionId(client);
  const row = await affiliates.insertConversion(
    { conversionId, affiliateId, leadId, clientId, type, amount, status },
    client
  );
  return serialize.toAffiliateConversion(row);
}

module.exports = { listAffiliates, getAffiliate, createAffiliate, updateAffiliate, recordConversion, slugify };
