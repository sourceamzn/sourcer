'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const org = require('../repositories/crm-admin.repo');
const users = require('../repositories/user.repo');
const authRepo = require('../repositories/auth.repo');
const audit = require('../repositories/audit.repo');
const password = require('../lib/password');
const serialize = require('../domain/serialize');
const { AppError } = require('../lib/errors');

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function nonEmpty(value) {
  const v = String(value == null ? '' : value).trim();
  return v || null;
}

/* ------------------------------- conjunto -------------------------------- */
/* Todo lo que el CRM necesita para pintar su administración de una sola vez:
   departamentos, desks, roles, estados, empleados y notas. */
async function bootstrap() {
  const [departments, desks, roles, statuses, employees, notes] = await Promise.all([
    org.listDepartments(),
    org.listDesks(),
    org.listRoles(),
    org.listLeadStatuses(),
    users.list(),
    org.listNotes({ limit: 500 }),
  ]);
  return {
    departments: departments.map(serialize.toDepartment),
    desks: desks.map(serialize.toDesk),
    roles: roles.map(serialize.toRole),
    statuses: statuses.map(serialize.toLeadStatus),
    employees: employees.map(serialize.toUser),
    notes: notes.map(serialize.toNote),
  };
}

/* ------------------------------ departamentos ----------------------------- */
async function listDepartments() {
  return (await org.listDepartments()).map(serialize.toDepartment);
}

async function createDepartment(input, actor) {
  const id = nonEmpty(input.id) || newId('dep');
  const existing = await org.findDepartment(id);
  if (existing) throw AppError.conflict('Ya existe un departamento con esa clave');
  const row = await org.insertDepartment({
    id,
    key: nonEmpty(input.key) || id,
    name: input.name,
    active: input.active,
  });
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.department.create', object: id });
  return serialize.toDepartment(row);
}

async function updateDepartment(id, changes, actor) {
  const existing = await org.findDepartment(id);
  if (!existing) throw AppError.notFound('Departamento no encontrado');
  const row = await org.updateDepartment(id, changes);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.department.update', object: id });
  return serialize.toDepartment(row);
}

async function deleteDepartment(id, actor) {
  const existing = await org.findDepartment(id);
  if (!existing) throw AppError.notFound('Departamento no encontrado');
  await org.deleteDepartment(id);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.department.delete', object: id });
  return { ok: true, id };
}

/* ---------------------------------- roles --------------------------------- */
async function listRoles() {
  return (await org.listRoles()).map(serialize.toRole);
}

async function createRole(input, actor) {
  const id = nonEmpty(input.id) || newId('role');
  const existing = await org.findRole(id);
  if (existing) throw AppError.conflict('Ya existe un rol con esa clave');
  const row = await org.insertRole({
    id,
    name: input.name,
    description: input.description,
    perms: input.perms || [],
  });
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.role.create', object: id });
  return serialize.toRole(row);
}

async function updateRole(id, changes, actor) {
  const existing = await org.findRole(id);
  if (!existing) throw AppError.notFound('Rol no encontrado');
  const row = await org.updateRole(id, changes);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.role.update', object: id });
  return serialize.toRole(row);
}

async function deleteRole(id, actor) {
  const existing = await org.findRole(id);
  if (!existing) throw AppError.notFound('Rol no encontrado');
  if (id === 'superadmin') throw AppError.forbidden('El rol Superadmin no se puede eliminar');
  await org.deleteRole(id);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.role.delete', object: id });
  return { ok: true, id };
}

/* ---------------------------------- desks --------------------------------- */
async function listDesks() {
  return (await org.listDesks()).map(serialize.toDesk);
}

async function createDesk(input, actor) {
  const id = nonEmpty(input.id) || newId('desk');
  const existing = await org.findDesk(id);
  if (existing) throw AppError.conflict('Ya existe un desk con esa clave');
  const row = await org.insertDesk({
    id,
    name: input.name,
    departmentId: input.departmentId,
    managerId: input.managerId,
    memberIds: input.memberIds || [],
    viewerIds: input.viewerIds || [],
    active: input.active,
  });
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.desk.create', object: id });
  return serialize.toDesk(row);
}

async function updateDesk(id, changes, actor) {
  const existing = await org.findDesk(id);
  if (!existing) throw AppError.notFound('Desk no encontrado');
  const row = await org.updateDesk(id, changes);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.desk.update', object: id });
  return serialize.toDesk(row);
}

async function deleteDesk(id, actor) {
  const existing = await org.findDesk(id);
  if (!existing) throw AppError.notFound('Desk no encontrado');
  await org.deleteDesk(id);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.desk.delete', object: id });
  return { ok: true, id };
}

/* ------------------------------ estados de lead --------------------------- */
async function listLeadStatuses() {
  return (await org.listLeadStatuses()).map(serialize.toLeadStatus);
}

async function createLeadStatus(input, actor) {
  const id = nonEmpty(input.id) || newId('st');
  const existing = await org.findLeadStatus(id);
  if (existing) throw AppError.conflict('Ya existe un estado con esa clave');
  const row = await org.insertLeadStatus({
    id,
    label: input.label,
    tone: input.tone,
    order: input.order,
    active: input.active,
  });
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.lead_status.create', object: id });
  return serialize.toLeadStatus(row);
}

async function updateLeadStatus(id, changes, actor) {
  const existing = await org.findLeadStatus(id);
  if (!existing) throw AppError.notFound('Estado no encontrado');
  const row = await org.updateLeadStatus(id, changes);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.lead_status.update', object: id });
  return serialize.toLeadStatus(row);
}

async function deleteLeadStatus(id, actor) {
  const existing = await org.findLeadStatus(id);
  if (!existing) throw AppError.notFound('Estado no encontrado');
  await org.deleteLeadStatus(id);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.lead_status.delete', object: id });
  return { ok: true, id };
}

/* -------------------------------- empleados ------------------------------- */
async function listEmployees() {
  return (await users.list()).map(serialize.toUser);
}

/* Crear un empleado es crear su usuario Y su credencial del realm crm con la
   contraseña que escribe el admin: así puede iniciar sesión desde cualquier
   equipo sin depender del navegador. */
async function createEmployee(input, actor) {
  const email = nonEmpty(input.email);
  if (!email || email.indexOf('@') < 0) {
    throw AppError.validation('El empleado necesita un email válido para iniciar sesión.');
  }
  if (!input.password || String(input.password).length < 8) {
    throw AppError.validation('La contraseña debe tener al menos 8 caracteres.');
  }

  return db.withTransaction(async (tx) => {
    const existingUser = await users.findByEmail(email, tx);
    if (existingUser) throw AppError.conflict('Ya existe un empleado con ese email.');
    const existingCred = await authRepo.findCredentialByEmail('crm', email, tx);
    if (existingCred) throw AppError.conflict('Ya existe una credencial de CRM para ese email.');

    const userId = await users.nextUserId(tx);
    const row = await users.insert(
      {
        userId,
        email,
        name: input.name,
        role: input.role || 'readonly',
        status: input.status || 'active',
        username: nonEmpty(input.username),
        phone: nonEmpty(input.phone),
        departmentId: nonEmpty(input.departmentId),
        deskId: nonEmpty(input.deskId),
        managerId: nonEmpty(input.managerId),
        visibleDeskIds: input.visibleDeskIds || [],
      },
      tx
    );

    const passwordHash = await password.hash(String(input.password));
    await authRepo.insertCredential(
      {
        subjectType: 'staff',
        subjectId: userId,
        email,
        passwordHash,
        realm: 'crm',
        emailVerifiedAt: new Date(),
      },
      tx
    );

    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'crm.employee.create', object: userId, details: { email, role: row.role } },
      tx
    );
    return serialize.toUser(row);
  });
}

async function updateEmployee(userId, changes, actor) {
  return db.withTransaction(async (tx) => {
    const existing = await users.findById(userId, tx);
    if (!existing) throw AppError.notFound('Empleado no encontrado');

    const row = await users.update(userId, changes, tx);

    const credential = await authRepo.findCredentialBySubject('staff', userId, 'crm', tx);
    if (credential) {
      if (changes.password !== undefined && changes.password !== null) {
        if (String(changes.password).length < 8) {
          throw AppError.validation('La contraseña debe tener al menos 8 caracteres.');
        }
        const passwordHash = await password.hash(String(changes.password));
        await authRepo.updatePassword(credential.credential_id, passwordHash, tx);
        await authRepo.revokeSessionsByActor('staff', userId, tx);
      }
      if (changes.email && changes.email.toLowerCase() !== credential.email.toLowerCase()) {
        await authRepo.updateCredentialEmail(credential.credential_id, changes.email, tx);
      }
    }

    await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.employee.update', object: userId });
    return serialize.toUser(row);
  });
}

async function deleteEmployee(userId, actor) {
  if (userId === actor.id) throw AppError.forbidden('No puede eliminar su propia cuenta.');
  return db.withTransaction(async (tx) => {
    const existing = await users.findById(userId, tx);
    if (!existing) throw AppError.notFound('Empleado no encontrado');
    await authRepo.revokeSessionsByActor('staff', userId, tx);
    await authRepo.deleteCredentialBySubject('staff', userId, 'crm', tx);
    await users.remove(userId, tx);
    await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.employee.delete', object: userId });
    return { ok: true, userId };
  });
}

async function setEmployeePassword(userId, input, actor) {
  if (!input.newPassword || String(input.newPassword).length < 8) {
    throw AppError.validation('La contraseña debe tener al menos 8 caracteres.');
  }
  return db.withTransaction(async (tx) => {
    const existing = await users.findById(userId, tx);
    if (!existing) throw AppError.notFound('Empleado no encontrado');
    const credential = await authRepo.findCredentialBySubject('staff', userId, 'crm', tx);
    if (!credential) throw AppError.notFound('El empleado no tiene acceso al CRM');
    const passwordHash = await password.hash(String(input.newPassword));
    await authRepo.updatePassword(credential.credential_id, passwordHash, tx);
    await authRepo.revokeSessionsByActor('staff', userId, tx);
    await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.employee.password', object: userId });
    return { ok: true, userId };
  });
}

/* ---------------------------------- notas --------------------------------- */
async function listNotes(query) {
  const rows = await org.listNotes({
    entityType: nonEmpty(query.entityType),
    entityId: nonEmpty(query.entityId),
    limit: query.limit,
  });
  return { items: rows.map(serialize.toNote) };
}

async function createNote(input, actor) {
  const row = await org.insertNote({
    id: newId('nt'),
    entityType: input.entityType,
    entityId: input.entityId,
    text: input.text,
    userId: actor.id,
  });
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.note.create', object: input.entityId });
  return serialize.toNote(row);
}

module.exports = {
  bootstrap,
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listDesks,
  createDesk,
  updateDesk,
  deleteDesk,
  listLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  deleteLeadStatus,
  listEmployees,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  setEmployeePassword,
  listNotes,
  createNote,
};
