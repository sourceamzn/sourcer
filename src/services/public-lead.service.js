'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const leads = require('../repositories/lead.repo');
const affiliates = require('../repositories/affiliate.repo');
const audit = require('../repositories/audit.repo');

/* Se guarda un hash del IP, nunca el IP en claro: basta para detectar abusos
   sin almacenar un dato personal directo. La sal toma el secreto del robot. */
function hashIp(ip) {
  const salt = process.env.JWT_SECRET || 'public-lead-salt';
  return crypto.createHash('sha256').update(`${salt}:${ip || ''}`).digest('hex');
}

function normalizeUtm(utm) {
  if (!utm || typeof utm !== 'object') return null;
  const out = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const value = utm[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      out[key] = String(value).slice(0, 120);
    }
  }
  return Object.keys(out).length ? out : null;
}

/* Valida un codigo de referido para el formulario publico. Solo devuelve el
   nombre del afiliado (nada sensible) y si esta activo. */
async function resolveReferral(code) {
  const affiliate = await affiliates.findByCode(code);
  if (!affiliate || affiliate.status !== 'active') return { valid: false };
  return { valid: true, code: affiliate.code, name: affiliate.name };
}

/* Alta publica de lead. No requiere sesion. Pensada para el formulario de la
   web: guarda el lead como "Nuevo", lo marca con origen y campana, y si trae
   codigo de referido lo asocia al afiliado. Nunca revela datos internos. */
async function createPublicLead(input, meta = {}) {
  /* Honeypot: un campo oculto que solo rellenan los robots. Si viene con
     contenido, se responde "ok" sin guardar nada para no darles pistas. */
  if (input.website) return { ok: true };

  const email = String(input.email || '').trim().toLowerCase();
  const affiliate = input.referral ? await affiliates.findByCode(input.referral) : null;
  const activeAffiliate = affiliate && affiliate.status === 'active' ? affiliate : null;
  const utm = normalizeUtm(input.utm);

  /* Un mismo correo no debe generar dos leads: se actualiza el existente y se
     conserva su numero (el CRM ya lo puede estar trabajando). */
  const existing = await leads.findByEmail(email);
  if (existing) {
    await leads.update(existing.lead_id, {
      firstName: input.firstName || existing.first_name,
      lastName: input.lastName || existing.last_name,
      phone: input.phone || existing.phone,
      country: input.country || existing.country,
      description: input.message || existing.description,
      campaignId: input.campaignId || existing.campaign_id,
      referralCode: activeAffiliate ? activeAffiliate.code : existing.referral_code,
      utm: utm || existing.utm,
    });
    if (activeAffiliate) {
      await recordLeadConversion(activeAffiliate.affiliate_id, existing.lead_id);
    }
    return { ok: true };
  }

  await db.withTransaction(async (tx) => {
    const leadId = await leads.nextLeadId(tx);
    await leads.insert(
      {
        leadId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email,
        age: input.age,
        description: input.message,
        statusId: 'st-new',
        campaignId: input.campaignId,
        source: input.source || 'web',
        country: input.country,
        referralCode: activeAffiliate ? activeAffiliate.code : null,
        utm,
        ipHash: hashIp(meta.ip),
        consentAt: new Date(),
      },
      tx
    );
    if (activeAffiliate) {
      const conversionId = await affiliates.nextConversionId(tx);
      await affiliates.insertConversion(
        { conversionId, affiliateId: activeAffiliate.affiliate_id, leadId, type: 'lead' },
        tx
      );
    }
    await audit.record(
      {
        actorType: 'public',
        actorId: null,
        action: 'lead.public.create',
        object: leadId,
        details: { source: input.source || 'web', referral: activeAffiliate ? activeAffiliate.code : null, utm },
      },
      tx
    );
  });

  return { ok: true };
}

/* Registra la conversion "lead" de forma idempotente (no duplica si ese lead ya
   estaba contado para el afiliado). */
async function recordLeadConversion(affiliateId, leadId) {
  const already = await affiliates.findConversionByLead(affiliateId, leadId);
  if (already) return;
  await db.withTransaction(async (tx) => {
    const conversionId = await affiliates.nextConversionId(tx);
    await affiliates.insertConversion({ conversionId, affiliateId, leadId, type: 'lead' }, tx);
  });
}

module.exports = { createPublicLead, resolveReferral };
