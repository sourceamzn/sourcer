'use strict';

const db = require('../db');
const clients = require('../repositories/client.repo');
const leads = require('../repositories/lead.repo');
const authRepo = require('../repositories/auth.repo');
const audit = require('../repositories/audit.repo');
const password = require('../lib/password');
const serialize = require('../domain/serialize');
const { parsePagination, paginate } = require('../lib/pagination');
const { AppError } = require('../lib/errors');

async function createClient(input, actor) {
  return db.withTransaction(async (tx) => {
    const existing = await clients.findByEmail(input.email, tx);
    if (existing) {
      if (input.leadId) await leads.markConverted(input.leadId, existing.client_id, tx);
      return { client: serialize.toClient(existing), created: false };
    }

    const clientId = await clients.nextClientId(tx);
    const row = await clients.insert(
      {
        clientId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        country: input.country,
        age: input.age,
        description: input.description,
        source: input.source,
        campaignId: input.campaignId,
        campaign: input.campaign,
        agentId: input.agentId,
        managerId: input.managerId,
        deskId: input.deskId,
        leadId: input.leadId,
        status: 'active',
        kycStatus: 'pending',
        convertedAt: new Date(),
      },
      tx
    );

    if (input.leadId) await leads.markConverted(input.leadId, clientId, tx);

    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'client.create', object: clientId, details: { source: input.source } },
      tx
    );

    return { client: serialize.toClient(row), created: true };
  });
}

async function getClient(clientId) {
  const row = await clients.findById(clientId);
  if (!row) throw AppError.notFound('Cliente no encontrado');
  return serialize.toClient(row);
}

async function updateClient(clientId, changes, actor) {
  const existing = await clients.findById(clientId);
  if (!existing) throw AppError.notFound('Cliente no encontrado');

  const allowed = actor.type === 'client' ? pickSelfEditable(changes) : changes;
  const row = await clients.update(clientId, allowed);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'client.update',
    object: clientId,
    details: { fields: Object.keys(allowed) },
  });
  return serialize.toClient(row);
}

function pickSelfEditable(changes) {
  const allowed = {};
  for (const key of ['firstName', 'lastName', 'phone', 'country', 'description']) {
    if (changes[key] !== undefined) allowed[key] = changes[key];
  }
  return allowed;
}

async function listClients(query) {
  const { limit, offset } = parsePagination(query);
  const search = query.search || null;
  const rows = await clients.list({ limit, offset, search });
  const total = await clients.count({ search });
  return paginate(rows.map(serialize.toClient), limit, offset, total);
}

async function convertClient(clientId, input, actor) {
  return db.withTransaction(async (tx) => {
    const existing = await clients.findById(clientId, tx);
    if (!existing) throw AppError.notFound('Cliente no encontrado');

    if (input.leadId) {
      const lead = await leads.findById(input.leadId, tx);
      if (!lead) throw AppError.notFound('Lead no encontrado');
      await leads.markConverted(input.leadId, clientId, tx);
    }

    const row = await clients.update(
      clientId,
      {
        leadId: input.leadId,
        agentId: input.agentId,
        managerId: input.managerId,
        deskId: input.deskId,
        campaignId: input.campaignId,
        campaign: input.campaign,
        status: 'active',
      },
      tx
    );
    await tx.query('UPDATE clients SET converted_at = COALESCE(converted_at, now()) WHERE client_id = $1', [clientId]);

    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'client.convert', object: clientId, details: { leadId: input.leadId || null } },
      tx
    );

    return serialize.toClient(row);
  });
}

async function setClientPassword(clientId, input, actor) {
  const existing = await clients.findById(clientId);
  if (!existing) throw AppError.notFound('Cliente no encontrado');
  if (!existing.email) {
    throw AppError.validation('El cliente no tiene email: no se puede crear su acceso al area de clientes');
  }

  return db.withTransaction(async (tx) => {
    const passwordHash = await password.hash(input.newPassword);
    const credential = await authRepo.findCredentialBySubject('client', clientId, 'client-area', tx);

    let email;
    if (credential) {
      /* El cliente ya tiene acceso: solo se cambia la contrasena. */
      await authRepo.updatePassword(credential.credential_id, passwordHash, tx);
      email = credential.email;
    } else {
      /* El cliente se creo desde el CRM (conversion de lead) y todavia no
         tiene acceso al area de clientes. Se crea en este momento con la
         contrasena que fija el administrador, sin exigir verificacion de
         email previa. */
      const byEmail = await authRepo.findCredentialByEmail('client-area', existing.email, tx);
      if (byEmail) {
        await authRepo.updatePassword(byEmail.credential_id, passwordHash, tx);
        if (byEmail.subject_type !== 'client' || byEmail.subject_id !== clientId) {
          await authRepo.linkCredentialSubject(byEmail.credential_id, 'client', clientId, tx);
        }
        email = byEmail.email;
      } else {
        const created = await authRepo.insertCredential(
          {
            subjectType: 'client',
            subjectId: clientId,
            email: existing.email,
            passwordHash,
            realm: 'client-area',
            status: 'active',
            emailVerifiedAt: new Date(),
          },
          tx
        );
        email = created.email;
      }
    }

    await authRepo.revokeSessionsByActor('client', clientId, tx);

    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'client.password.set', object: clientId },
      tx
    );

    return { ok: true, clientId, email };
  });
}

/* Borrado DEFINITIVO del cliente y todo lo que cuelga de él (cuentas de
   trading, operativa, solicitudes, tickets, documentos KYC, leads, notas,
   tareas y credenciales/sesiones). Solo administradores y managers. Se anota
   en auditoría el alcance del borrado antes de ejecutarlo, y todo ocurre en
   una misma transacción: o se destruye por completo, o no se toca nada. */
async function deleteClient(clientId, actor) {
  const existing = await clients.findById(clientId);
  if (!existing) throw AppError.notFound('Cliente no encontrado');

  return db.withTransaction(async (tx) => {
    const scope = await clients.treeSummary(clientId, tx);
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'client.delete',
        object: clientId,
        details: { email: existing.email, scope },
      },
      tx
    );
    await clients.removeTree(clientId, tx);
    return { ok: true, clientId, deleted: scope };
  });
}

/* Borrado definitivo por selección. La ruta restringe a manager/superadmin.
   Cada cliente se destruye con todo su árbol dentro de la MISMA transacción:
   o se borran todos los seleccionados, o no se toca ninguno. */
async function deleteClients(clientIds, actor) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!ids.length) throw AppError.validation('No hay clientes seleccionados');

  return db.withTransaction(async (tx) => {
    const deleted = [];
    for (const clientId of ids) {
      const existing = await clients.findById(clientId, tx);
      if (!existing) continue;
      const scope = await clients.treeSummary(clientId, tx);
      await audit.record(
        {
          actorType: actor.type,
          actorId: actor.id,
          action: 'client.delete',
          object: clientId,
          details: { email: existing.email, scope, batch: true },
        },
        tx
      );
      await clients.removeTree(clientId, tx);
      deleted.push(clientId);
    }
    return { ok: true, requested: ids.length, deleted: deleted.length, clientIds: deleted };
  });
}

module.exports = {
  createClient,
  getClient,
  updateClient,
  listClients,
  convertClient,
  setClientPassword,
  deleteClient,
  deleteClients,
};
