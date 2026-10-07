'use strict';

const db = require('../db');
const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const serialize = require('../domain/serialize');
const { assertClientAccess } = require('../middleware/authorize');
const accounts = require('../repositories/trading-account.repo');
const operativa = require('../repositories/operativa.repo');
const audit = require('../repositories/audit.repo');
const market = require('./market-data.service');
const valuation = require('./valuation.service');

const SIDES = ['buy', 'sell'];
const PENDING_TYPES = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'];

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

async function loadAccount(accountId, actor, tx) {
  const account = await accounts.findById(accountId, tx);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  return account;
}

async function loadPosition(positionId, actor, tx, { forUpdate = false } = {}) {
  const position = await operativa.findPositionById(positionId, tx, { forUpdate });
  if (!position) throw AppError.notFound('Posición no encontrada');
  const account = await accounts.findByNumber(position.account_number, tx);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  return { position, account };
}

/* Precio de mercado real para abrir una operación cuando el cliente no envía
   uno (p. ej. el Manager ejecuta «a mercado»). Una compra se abre en el Ask y
   una venta en el Bid; sin cotización no se inventa nada y se devuelve null. */
async function marketPriceFor(symbol, side) {
  try {
    const quotes = await market.getQuotes([{ symbol }]);
    const quote = quotes[symbol];
    if (!quote) return null;
    const price = side === 'sell'
      ? (quote.bid != null ? quote.bid : quote.mid)
      : (quote.ask != null ? quote.ask : quote.mid);
    return num(price);
  } catch (err) {
    return null;
  }
}

/* Regla de saldo: no se puede operar sin haber ingresado fondos, ni por encima
   del saldo disponible. Calcula el margen que exige la operación y lo compara
   con el margen libre real de la cuenta (valoración del robot). Sin saldo, sin
   margen libre o si el margen exigido supera el libre, se rechaza la operación.
   Es la comprobación del servidor: la Terminal hace la suya para avisar antes. */
async function assertFreeMargin(account, instrument, price, volume) {
  const [summary] = await valuation.buildSummaries([account]);
  const required = valuation.marginForPosition(account, instrument, price, volume);
  if (required == null) {
    throw AppError.validation('No se pudo calcular el margen de la operación (falta el tipo de cambio).');
  }
  const currency = summary.currency || account.currency || 'EUR';
  const equity = Number(summary.equity) || 0;
  const free = Number(summary.freeMargin) || 0;
  if (!(equity > 0) || !(free > 0)) {
    throw AppError.conflict('No hay saldo disponible: ingresa fondos en tu Área de Cliente antes de operar.');
  }
  if (required > free + 0.005) {
    throw AppError.conflict(
      `Margen insuficiente: esta operación necesita ${required.toFixed(2)} ${currency} y la cuenta tiene ${free.toFixed(2)} ${currency} libres.`
    );
  }
}

async function openPosition(accountId, input, actor) {
  const symbol = normalizeSymbol(input.symbol);
  const side = input.side;
  const volume = num(input.volume);
  if (!(volume > 0)) throw AppError.validation('Volumen no válido');
  if (SIDES.indexOf(side) < 0) throw AppError.validation('Dirección no válida');

  /* La cuenta y el instrumento se leen antes de abrir la transacción para poder
     comprobar el saldo/margen (que consulta la valoración) sin mantener
     bloqueada la fila de la cuenta durante esa consulta. */
  const account = await accounts.findById(accountId);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  if (account.status !== 'active') {
    throw AppError.conflict(`Operativa no permitida: la cuenta está ${account.status}`);
  }

  const instrument = await operativa.findInstrument(symbol);
  if (!instrument) throw AppError.validation('Instrumento desconocido');

  /* Si no llega precio, lo pone el propio robot con el mercado real. */
  let price = num(input.price != null ? input.price : input.openPrice);
  if (!(price > 0)) price = await marketPriceFor(symbol, side);
  if (!(price > 0)) throw AppError.validation(`Sin cotización para ${symbol}: no se puede abrir la operación.`);

  await assertFreeMargin(account, instrument, price, volume);

  return db.withTransaction(async (tx) => {
    const locked = await loadAccount(accountId, actor, tx);
    if (locked.status !== 'active') {
      throw AppError.conflict(`Operativa no permitida: la cuenta está ${locked.status}`);
    }

    const ticket = await operativa.nextTicket('position', account.number, tx);

    const row = await operativa.insertPosition(
      {
        id: ids.positionId(),
        ticket,
        accountNumber: account.number,
        symbol,
        side,
        volume,
        openPrice: price,
        sl: num(input.sl),
        tp: num(input.tp),
        profit: 0,
        status: 'open',
      },
      tx
    );

    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'position.open',
        object: row.id,
        details: { accountId, symbol, side, volume, price, reason: input.reason || null },
      },
      tx
    );

    return serialize.toPosition(row);
  });
}

async function placeOrder(accountId, input, actor) {
  const type = input.type || 'market';
  if (type === 'market') return openPosition(accountId, input, actor);

  if (PENDING_TYPES.indexOf(type) < 0) throw AppError.validation('Tipo de orden no válido');
  const symbol = normalizeSymbol(input.symbol);
  const volume = num(input.volume);
  if (!(volume > 0)) throw AppError.validation('Volumen no válido');
  const price = num(input.price);
  if (!(price > 0)) throw AppError.validation('Precio no válido');

  /* Una orden pendiente también reserva margen: no se admite colocar órdenes
     sin saldo ni por encima del margen libre, igual que una operación a mercado. */
  const account = await accounts.findById(accountId);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  if (account.status !== 'active') {
    throw AppError.conflict(`Operativa no permitida: la cuenta está ${account.status}`);
  }

  const instrument = await operativa.findInstrument(symbol);
  if (!instrument) throw AppError.validation('Instrumento desconocido');

  await assertFreeMargin(account, instrument, price, volume);

  return db.withTransaction(async (tx) => {
    const locked = await loadAccount(accountId, actor, tx);
    if (locked.status !== 'active') {
      throw AppError.conflict(`Operativa no permitida: la cuenta está ${locked.status}`);
    }

    const side = type.indexOf('buy') === 0 ? 'buy' : 'sell';
    const ticket = await operativa.nextTicket('order', locked.number, tx);
    const row = await operativa.insertOrder(
      {
        id: ids.orderId(),
        ticket,
        accountNumber: locked.number,
        symbol,
        type,
        side,
        volume,
        price,
        sl: num(input.sl),
        tp: num(input.tp),
        status: 'pending',
      },
      tx
    );

    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'order.place',
        object: row.id,
        details: { accountId, symbol, type, volume, price, reason: input.reason || null },
      },
      tx
    );

    return serialize.toOrder(row);
  });
}

async function modifyPosition(positionId, input, actor) {
  return db.withTransaction(async (tx) => {
    const { position } = await loadPosition(positionId, actor, tx, { forUpdate: true });

    const patch = {};
    if (input.sl !== undefined) patch.sl = num(input.sl);
    if (input.tp !== undefined) patch.tp = num(input.tp);
    if (input.openPrice !== undefined) {
      const openPrice = num(input.openPrice);
      if (openPrice !== null && !(openPrice > 0)) {
        throw AppError.validation('Precio de apertura no válido');
      }
      patch.open_price = openPrice;
    }

    const row = await operativa.updatePosition(position.id, patch, tx);

    /* El precio de apertura es una corrección administrativa: queda auditado
       con el valor anterior y el nuevo. El P/L realizado se recalcula solo al
       cerrar la posición, porque el cierre usa `open_price` como referencia. */
    const priceChanged = input.openPrice !== undefined && Number(position.open_price) !== Number(row.open_price);
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: priceChanged ? 'position.open_price' : 'position.modify',
        object: position.id,
        details: {
          openPriceBefore: position.open_price == null ? null : Number(position.open_price),
          openPriceAfter: row.open_price == null ? null : Number(row.open_price),
          sl: row.sl,
          tp: row.tp,
          reason: input.reason || null,
        },
      },
      tx
    );
    return serialize.toPosition(row);
  });
}

async function closePosition(positionId, input, actor) {
  /* Los tipos de cambio se cargan una vez, fuera del bloqueo de la fila, para no
     alargar la transacción con una llamada de red. */
  await market.ensureRates().catch(() => {});
  return db.withTransaction(async (tx) => {
    const { position, account } = await loadPosition(positionId, actor, tx, { forUpdate: true });

    const volume = num(input.volume) || Number(position.volume);
    if (!(volume > 0) || volume > Number(position.volume)) {
      throw AppError.validation('Volumen de cierre no válido');
    }

    const instrument = await operativa.findInstrument(position.symbol, tx);
    /* Si el cliente no envía precio de cierre, lo pone el robot con el mercado
       real: una compra se cierra en el Bid y una venta en el Ask. */
    let closePrice = num(input.price != null ? input.price : input.closePrice);
    if (!(closePrice > 0)) {
      closePrice = await marketPriceFor(position.symbol, position.side === 'buy' ? 'sell' : 'buy');
    }
    const openPrice = Number(position.open_price) || 0;
    const direction = position.side === 'buy' ? 1 : -1;
    const contract = instrument ? Number(instrument.contract_size) : 1;
    /* El P/L nace en la divisa de cotización del instrumento (o en la de la
       cuenta si el instrumento no la declara) y se expresa en la divisa de la
       cuenta, que es la única cifra que el cliente puede interpretar. */
    const quoteCcy = instrument && instrument.ccy ? instrument.ccy : account.currency;
    const quote = ((closePrice == null ? openPrice : closePrice) - openPrice) * direction * contract * volume;
    const converted = market.convert(quote, quoteCcy, account.currency);
    const profit = round2(converted == null ? quote : converted);

    const ticket = await operativa.nextTicket('trade', position.account_number, tx);
    const tradeNumber = await operativa.nextNumber('trade', tx);
    const trade = await operativa.insertTrade(
      {
        id: ids.tradeId(tradeNumber),
        ticket,
        accountNumber: position.account_number,
        symbol: position.symbol,
        side: position.side,
        volume,
        openPrice,
        closePrice,
        profit,
        openedAt: position.opened_at,
        closedAt: new Date(),
      },
      tx
    );

    const updatedAccount = await accounts.applyBalance(account.account_id, profit, tx);

    const txNumber = await operativa.nextNumber('transaction', tx);
    await operativa.insertTransaction(
      {
        id: ids.transactionId(txNumber),
        accountNumber: position.account_number,
        type: 'trade',
        amount: profit,
        currency: account.currency,
        balanceAfter: updatedAccount ? Number(updatedAccount.balance) : 0,
        note: `Cierre ${trade.id} · ${position.symbol}`,
      },
      tx
    );

    if (volume >= Number(position.volume)) {
      await operativa.deletePosition(position.id, tx);
    } else {
      await operativa.updatePosition(position.id, { volume: Number(position.volume) - volume }, tx);
    }

    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'position.close',
        object: position.id,
        details: { accountId: account.account_id, symbol: position.symbol, volume, closePrice, profit, reason: input.reason || null },
      },
      tx
    );

    return serialize.toTrade(trade);
  });
}

async function cancelOrder(orderId, input, actor) {
  return db.withTransaction(async (tx) => {
    const order = await operativa.findOrderById(orderId, tx, { forUpdate: true });
    if (!order) throw AppError.notFound('Orden no encontrada');

    const account = await accounts.findByNumber(order.account_number, tx);
    if (!account) throw AppError.notFound('Cuenta no encontrada');
    assertClientAccess(actor, account.client_id);

    if (order.status !== 'pending') throw AppError.conflict('La orden ya no está pendiente');

    const row = await operativa.updateOrder(order.id, { status: 'cancelled' }, tx);
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'order.cancel',
        object: order.id,
        details: { accountId: account.account_id, reason: input && input.reason ? input.reason : null },
      },
      tx
    );
    return serialize.toOrder(row);
  });
}

async function modifyOrder(orderId, input, actor) {
  return db.withTransaction(async (tx) => {
    const order = await operativa.findOrderById(orderId, tx, { forUpdate: true });
    if (!order) throw AppError.notFound('Orden no encontrada');

    const account = await accounts.findByNumber(order.account_number, tx);
    if (!account) throw AppError.notFound('Cuenta no encontrada');
    assertClientAccess(actor, account.client_id);

    if (order.status !== 'pending') throw AppError.conflict('La orden ya no está pendiente');

    const patch = {};
    if (input.price !== undefined) {
      const price = num(input.price);
      if (!(price > 0)) throw AppError.validation('Precio no válido');
      patch.price = price;
    }
    if (input.sl !== undefined) patch.sl = num(input.sl);
    if (input.tp !== undefined) patch.tp = num(input.tp);

    const row = await operativa.updateOrder(order.id, patch, tx);
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.id,
        action: 'order.modify',
        object: order.id,
        details: { price: row.price, sl: row.sl, tp: row.tp, reason: input.reason || null },
      },
      tx
    );
    return serialize.toOrder(row);
  });
}

module.exports = { openPosition, placeOrder, modifyPosition, modifyOrder, closePosition, cancelOrder };
