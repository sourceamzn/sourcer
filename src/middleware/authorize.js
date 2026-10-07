'use strict';

const { AppError } = require('../lib/errors');

const STAFF_ROLES = ['superadmin', 'manager', 'sales_agent', 'support'];

/* Roles con poder destructivo (borrado definitivo de leads y clientes). El
   Trading Manager (actor 'tm') es back-office de administración, por lo que se
   le considera equivalente a un manager/superadmin. */
const DELETE_ROLES = ['superadmin', 'manager'];

function isStaff(actor) {
  return Boolean(actor) && actor.type === 'staff';
}

function isTm(actor) {
  return Boolean(actor) && (actor.type === 'tm' || actor.type === 'system');
}

function isSystem(actor) {
  return Boolean(actor) && actor.type === 'system';
}

function canAccessClient(actor, clientId) {
  if (!actor) return false;
  if (isSystem(actor) || isTm(actor) || isStaff(actor)) return true;
  return actor.type === 'client' && actor.clientId === clientId;
}

function assertClientAccess(actor, clientId) {
  if (!canAccessClient(actor, clientId)) {
    throw AppError.forbidden('No puedes acceder a este cliente');
  }
}

function requireActor(...types) {
  return async function actorHook(request) {
    if (!request.actor) throw AppError.unauthorized();
    if (types.length && !types.includes(request.actor.type)) {
      throw AppError.forbidden();
    }
  };
}

function requireRole(...roles) {
  return async function roleHook(request) {
    if (!isStaff(request.actor)) throw AppError.forbidden();
    if (roles.length && !roles.includes(request.actor.role)) throw AppError.forbidden();
  };
}

/* Solo superadmin, manager o el Trading Manager pueden borrar definitivamente.
   El personal de menor rango (agentes de ventas y retención, soporte) no. */
function isManagerOrAdmin(actor) {
  if (!actor) return false;
  if (actor.type === 'tm' || actor.type === 'system') return true;
  return actor.type === 'staff' && DELETE_ROLES.includes(actor.role);
}

function requireManagerOrAdmin() {
  return async function destructiveHook(request) {
    if (!request.actor) throw AppError.unauthorized();
    if (!isManagerOrAdmin(request.actor)) {
      throw AppError.forbidden('Solo administradores y managers pueden eliminar');
    }
  };
}

module.exports = {
  STAFF_ROLES,
  DELETE_ROLES,
  isStaff,
  isTm,
  isSystem,
  isManagerOrAdmin,
  canAccessClient,
  assertClientAccess,
  requireActor,
  requireRole,
  requireManagerOrAdmin,
};
