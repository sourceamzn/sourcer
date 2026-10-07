'use strict';

const db = require('../db');
const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const serialize = require('../domain/serialize');
const { assertClientAccess } = require('../middleware/authorize');
const accounts = require('../repositories/trading-account.repo');
const operativa = require('../repositories/operativa.repo');
const audit = require('../repositories/audit.repo');

/* Estados en los que se permite mover dinero. Una cuenta suspendida o cerrada
   queda bloqueada (y una archivada, por definicion). */
const OPEN_STATUSES = ['active', 'pending'];

const TYPES = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  bonus: 'bonus',
  bonus_removal: 'bonus_removal',
  transfer_out: 'transfer_out',
  transfer_in: 'transfer_in',
  adjustment: 'adjustment',
};

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function amountOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round2(parsed) : null;
}

async function existingByKey(key, tx) {
  if (!key) return null;
  return operativa.findTransactionByIdempotency(key, tx);
}

async function loadAccount(accountId, actor, tx, { forUpdate = false } = {}) {
  const account = await accounts.findById(accountId, tx);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  if (forUpdate) {
    // Bloquea la fila para serializar movimientos concurrentes sobre el saldo.
    await db.query('SELECT 1 FROM trading_accounts WHERE account_id = $1 FOR UPDATE', [accountId], tx);
  }
  return account;
}

function assertOperable(account) {
  if (account.archived) throw AppError.conflict('La cuenta está archivada');
  if (OPEN_STATUSES.indexOf(account.status) < 0) {
    throw AppError.conflict(`Operativa no permitida: la cuenta está ${account.status}`);
  }
}

function note(parts) {
  const text = parts.filter(Boolean).join(' · ').trim();
  return text || null;
}

async function recordMovement(account, type, signedAmount, meta, actor, tx) {
  const number = await operativa.nextNumber('transaction', tx);
  const row = await operativa.insertTransaction(
    {
      id: ids.transactionId(number),
      accountNumber: account.number,
      type,
      amount: signedAmount,
      currency: account.currency,
      balanceAfter: Number(account.balance) || 0,
      note: meta.note || null,
      idempotencyKey: meta.idempotencyKey || null,
      ref: meta.ref || null,
    },
    tx
  );
  await audit.record(
    {
      actorType: actor.type,
      actorId: actor.id,
      action: `money.${type}`,
      object: account.account_id,
      details: {
        amount: signedAmount,
        currency: account.currency,
        balance: Number(account.balance),
        bonus: Number(account.bonus),
        reference: meta.reference || null,
        note: meta.note || null,
        ref: meta.ref || null,
      },
    },
    tx
  );
  return row;
}

async function deposit(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const done = await existingByKey(input.idempotencyKey, tx);
    if (done) return serialize.toTransaction(done);

    const account = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(account);

    const amount = amountOf(input.amount);
    if (!(amount > 0)) throw AppError.validation('Importe no válido');

    const updated = await accounts.applyBalance(account.account_id, amount, tx);
    const row = await recordMovement(
      updated,
      TYPES.deposit,
      amount,
      {
        note: note([input.method, input.reference, input.comment]) || 'Depósito',
        reference: input.reference || null,
        idempotencyKey: input.idempotencyKey || null,
      },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

async function withdraw(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const done = await existingByKey(input.idempotencyKey, tx);
    if (done) return serialize.toTransaction(done);

    const account = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(account);

    const amount = amountOf(input.amount);
    if (!(amount > 0)) throw AppError.validation('Importe no válido');
    if (amount > Number(account.balance)) throw AppError.conflict('Saldo insuficiente');

    const updated = await accounts.applyBalance(account.account_id, -amount, tx);
    const row = await recordMovement(
      updated,
      TYPES.withdrawal,
      -amount,
      {
        note: note([input.method, input.reference, input.comment]) || 'Retirada',
        reference: input.reference || null,
        idempotencyKey: input.idempotencyKey || null,
      },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

async function addBonus(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const account = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(account);

    const amount = amountOf(input.amount);
    if (!(amount > 0)) throw AppError.validation('Importe no válido');

    const updated = await accounts.applyBonus(account.account_id, amount, tx);
    const row = await recordMovement(
      updated,
      TYPES.bonus,
      amount,
      { note: input.reason || 'Bono', reference: 'Bono' },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

async function removeBonus(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const account = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(account);

    const amount = amountOf(input.amount);
    if (!(amount > 0)) throw AppError.validation('Importe no válido');
    if (amount > Number(account.bonus)) throw AppError.conflict('El importe supera el bono disponible');

    const updated = await accounts.applyBonus(account.account_id, -amount, tx);
    const row = await recordMovement(
      updated,
      TYPES.bonus_removal,
      -amount,
      { note: input.reason || 'Retirada de bono', reference: 'Bono' },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

async function adjust(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const account = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(account);

    const amount = amountOf(input.amount);
    if (amount === null || amount === 0) throw AppError.validation('Importe no válido');

    const updated = await accounts.applyBalance(account.account_id, amount, tx);
    const row = await recordMovement(
      updated,
      TYPES.adjustment,
      amount,
      { note: input.reason || 'Ajuste de balance', reference: 'Ajuste' },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

async function transfer(accountId, input, actor) {
  return db.withTransaction(async (tx) => {
    const done = await existingByKey(input.idempotencyKey, tx);
    if (done) return serialize.toTransaction(done);

    const from = await loadAccount(accountId, actor, tx, { forUpdate: true });
    assertOperable(from);

    const target = input.toAccountId
      ? await accounts.findById(input.toAccountId, tx)
      : await accounts.findByNumber(input.toNumber, tx);
    if (!target) throw AppError.notFound('Cuenta destino no encontrada');
    if (target.account_id === from.account_id) throw AppError.validation('Selecciona dos cuentas distintas');
    assertClientAccess(actor, target.client_id);
    assertOperable(target);
    await db.query('SELECT 1 FROM trading_accounts WHERE account_id = $1 FOR UPDATE', [target.account_id], tx);

    const amount = amountOf(input.amount);
    if (!(amount > 0)) throw AppError.validation('Importe no válido');
    if (amount > Number(from.balance)) throw AppError.conflict('Saldo insuficiente');

    const updatedFrom = await accounts.applyBalance(from.account_id, -amount, tx);
    const updatedTo = await accounts.applyBalance(target.account_id, amount, tx);

    await recordMovement(
      updatedFrom,
      TYPES.transfer_out,
      -amount,
      {
        note: note([input.comment, `→ ${target.number}`]) || `Transferencia a ${target.number}`,
        reference: 'Transferencia',
        ref: String(target.number),
        idempotencyKey: input.idempotencyKey || null,
      },
      actor,
      tx
    );
    const row = await recordMovement(
      updatedTo,
      TYPES.transfer_in,
      amount,
      {
        note: note([input.comment, `← ${from.number}`]) || `Transferencia de ${from.number}`,
        reference: 'Transferencia',
        ref: String(from.number),
      },
      actor,
      tx
    );
    return serialize.toTransaction(row);
  });
}

module.exports = { deposit, withdraw, addBonus, removeBonus, adjust, transfer };
