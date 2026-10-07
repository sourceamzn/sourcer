'use strict';

const db = require('../db');
const leads = require('../repositories/lead.repo');
const audit = require('../repositories/audit.repo');
const serialize = require('../domain/serialize');
const { AppError } = require('../lib/errors');
const { parsePagination, paginate } = require('../lib/pagination');

/* Un actor puede repartir cartera si es Manager, Superadmin, el Trading
   Manager o el sistema. Cualquier otro empleado del CRM (agente de ventas o
   retención) queda ceñido a su propia cartera. */
const MANAGER_ROLES = ['manager', 'superadmin'];
function isManagerLike(actor) {
  if (!actor) return false;
  if (actor.type === 'tm' || actor.type === 'system') return true;
  return MANAGER_ROLES.includes(actor.role);
}

/* Los agentes solo pueden ver y tocar los leads de su cartera. El alcance de
   LECTURA se resuelve en la interfaz, pero el robot refuerza la escritura:
   crear un lead siempre lo asigna al agente y editar/eliminar exige que el
   lead ya sea suyo. */
function assertLeadScope(existing, actor) {
  if (!actor || actor.type !== 'staff' || isManagerLike(actor)) return;
  if (existing.agent_id !== actor.id) {
    throw AppError.forbidden('Este lead no está en su cartera');
  }
}

function enforceAgentScope(changes, actor) {
  if (!actor || actor.type !== 'staff' || isManagerLike(actor)) return changes;
  if (changes.agentId === undefined) return changes;
  return { ...changes, agentId: actor.id };
}

async function listLeads(query) {
  const { limit, offset } = parsePagination(query);
  const search = query.search || null;
  const statusId = query.statusId || null;
  const rows = await leads.list({ limit, offset, search, statusId });
  const total = await leads.count({ search, statusId });
  return paginate(rows.map(serialize.toLead), limit, offset, total);
}

/* Crea un lead "Nuevo" para cada cliente que todavia no tenga uno. Es
   idempotente: solo toca los clientes sin lead, asi que se puede repetir sin
   duplicar. Sirve para que el CRM vea las altas anteriores al puente web. */
async function backfillLeads() {
  const pending = await leads.listClientsWithoutLead();
  if (!pending.length) return { scanned: 0, created: 0 };

  const created = await db.withTransaction(async (tx) => {
    let n = 0;
    for (const c of pending) {
      const leadId = await leads.nextLeadId(tx);
      await leads.insert(
        {
          leadId,
          firstName: c.first_name,
          lastName: c.last_name,
          email: c.email,
          phone: c.phone,
          source: c.source || 'web',
          description: 'Alta web desde el área de clientes',
          statusId: 'st-new',
          clientId: c.client_id,
        },
        tx
      );
      n += 1;
    }
    return n;
  });

  return { scanned: pending.length, created };
}

/* Alta manual del CRM: crea un lead con el siguiente numero canonico. Un
   agente no puede regalar cartera ajena: si no es manager, el lead queda
   siempre a su nombre. */
async function createLead(input, actor) {
  const scoped = isManagerLike(actor) ? input : { ...input, agentId: actor.id };
  return db.withTransaction(async (tx) => {
    const leadId = await leads.nextLeadId(tx);
    const row = await leads.insert(
      {
        leadId,
        firstName: scoped.firstName,
        lastName: scoped.lastName,
        phone: scoped.phone,
        email: scoped.email,
        age: scoped.age,
        description: scoped.description,
        statusId: scoped.statusId || 'st-new',
        agentId: scoped.agentId,
        managerId: scoped.managerId,
        deskId: scoped.deskId,
        campaignId: scoped.campaignId,
        campaign: scoped.campaign,
        source: scoped.source || 'crm',
      },
      tx
    );
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'lead.create', object: leadId },
      tx
    );
    return serialize.toLead(row);
  });
}

async function updateLead(leadId, changes, actor) {
  const existing = await leads.findById(leadId);
  if (!existing) throw AppError.notFound('Lead no encontrado');
  assertLeadScope(existing, actor);
  const scoped = enforceAgentScope(changes, actor);
  const row = await leads.update(leadId, scoped);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'lead.update',
    object: leadId,
    details: { fields: Object.keys(scoped) },
  });
  return serialize.toLead(row);
}

async function deleteLead(leadId, actor) {
  const existing = await leads.findById(leadId);
  if (!existing) throw AppError.notFound('Lead no encontrado');
  assertLeadScope(existing, actor);
  await leads.remove(leadId);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'lead.delete', object: leadId });
  return { ok: true, leadId };
}

/* Borrado definitivo por selección. La ruta ya restringe a manager/superadmin
   /tm, aquí solo se valida la entrada y se anota el alcance en auditoría. */
async function deleteLeads(leadIds, actor) {
  const ids = [...new Set((leadIds || []).filter(Boolean))];
  if (!ids.length) throw AppError.validation('No hay leads seleccionados');
  return db.withTransaction(async (tx) => {
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'lead.delete', object: 'batch', details: { requested: ids.length } },
      tx
    );
    const deleted = await leads.removeMany(ids, tx);
    return { ok: true, requested: ids.length, deleted };
  });
}

function normalizeEmail(email) {
  const value = (email || '').trim().toLowerCase();
  if (!value) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}

/* Importación masiva de leads (p. ej. la base de MyInvestor). Deduplica por
   correo DENTRO del lote (no fusiona con clientes ni leads existentes) y crea
   todos los leads en una sola transacción. */
async function importLeads(rows, actor) {
  const batch = Array.isArray(rows) ? rows : [];
  if (!batch.length) throw AppError.validation('El lote está vacío');

  /* Sella todas las filas con un identificador de lote para poder deshacer la
     ultima importacion completa desde el CRM. */
  const importBatch = 'imp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const seen = new Set();
  const clean = [];
  let skipped = 0;
  for (const r of batch) {
    const email = normalizeEmail(r.email);
    if (email && seen.has(email)) {
      skipped += 1;
      continue;
    }
    if (email) seen.add(email);
    clean.push({ ...r, email });
  }

  const created = await db.withTransaction(async (tx) => {
    const out = [];
    for (const r of clean) {
      const leadId = await leads.nextLeadId(tx);
      const row = await leads.insert(
        {
          leadId,
          firstName: r.firstName || null,
          lastName: r.lastName || null,
          phone: r.phone || null,
          email: r.email || null,
          description: r.description || null,
          statusId: r.statusId || 'st-new',
          agentId: r.agentId || actor.id,
          managerId: r.managerId || null,
          deskId: r.deskId || null,
          campaignId: r.campaignId || null,
          campaign: r.campaign || null,
          source: r.source || 'import',
          importBatch,
        },
        tx
      );
      out.push(serialize.toLead(row));
    }
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'lead.import',
        object: importBatch,
        details: { received: batch.length, created: out.length, skipped },
      },
      tx
    );
    return out;
  });

  return { created: created.length, skipped, batch: importBatch, leads: created };
}

/* Deshace la ultima importacion masiva: borra definitivamente todos los leads
   del lote de importacion mas reciente. Reservado a manager/superadmin desde
   la ruta. Devuelve cuantos leads se eliminaron. */
async function undoLastImport(actor) {
  return db.withTransaction(async (tx) => {
    const last = await leads.lastImportBatch(tx);
    if (!last || !last.batch) return { deleted: 0, batch: null };
    const deleted = await leads.removeByBatch(last.batch, tx);
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'lead.import.undo',
        object: last.batch,
        details: { batch: last.batch, deleted },
      },
      tx
    );
    return { deleted, batch: last.batch };
  });
}

module.exports = {
  listLeads,
  backfillLeads,
  createLead,
  updateLead,
  deleteLead,
  deleteLeads,
  importLeads,
  undoLastImport,
};
