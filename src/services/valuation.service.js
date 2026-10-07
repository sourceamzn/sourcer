'use strict';

/* Valoración de cuentas: la única fuente de verdad del resultado flotante.
 *
 * Calcula, para cada cuenta, el P/L de cada posición abierta con el precio REAL,
 * lo pasa a la divisa de la cuenta y deriva:
 *
 *   patrimonio (equity) = balance + bono + P/L flotante
 *   margen usado        = suma(notional en divisa de cuenta) / apalancamiento
 *   margen libre        = patrimonio - margen usado
 *   nivel de margen     = patrimonio / margen usado * 100
 *
 * Nunca inventa un precio: si un instrumento no tiene cotización, su P/L queda
 * a `null` y el precio se marca como «sin precio». El frontend (Terminal,
 * Manager y Cabinet) consume esta valoración en vez de calcularla por su cuenta.
 */

const { AppError } = require('../lib/errors');
const { assertClientAccess } = require('../middleware/authorize');
const accounts = require('../repositories/trading-account.repo');
const operativa = require('../repositories/operativa.repo');
const market = require('./market-data.service');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* Precio al que se valoraría la posición si se cerrase ahora: una compra se
   cierra en el Bid y una venta en el Ask. Sin Bid/Ask se usa el precio medio. */
function closingPrice(side, quote) {
  if (!quote) return null;
  if (side === 'buy') return quote.bid != null ? quote.bid : quote.mid;
  return quote.ask != null ? quote.ask : quote.mid;
}

async function buildSummaries(accountRows) {
  const list = (accountRows || []).filter(Boolean);
  if (!list.length) return [];

  await market.ensureRates();

  const numbers = list.map((a) => a.number);
  const positions = await operativa.listPositionsByAccounts(numbers);
  const open = positions.filter((p) => p.status === 'open');
  const symbols = Array.from(new Set(open.map((p) => p.symbol)));
  const instruments = symbols.length ? await operativa.findInstrumentsBySymbols(symbols) : {};
  const quotes = symbols.length ? await market.getQuotes(symbols.map((s) => ({ symbol: s }))) : {};

  const byAccount = {};
  open.forEach((p) => {
    const key = String(p.account_number);
    if (!byAccount[key]) byAccount[key] = [];
    byAccount[key].push(p);
  });

  return list.map((account) => {
    const accountCcy = String(account.currency || 'EUR').toUpperCase();
    const leverage = Number(account.leverage) || 100;
    let floating = 0;
    let margin = 0;
    let anyUnpriced = false;

    const rows = (byAccount[String(account.number)] || []).map((p) => {
      const instrument = instruments[p.symbol] || null;
      const quote = quotes[p.symbol] || null;
      const contract = instrument ? Number(instrument.contract_size) || 1 : 1;
      const quoteCcy = String((instrument && instrument.ccy) || accountCcy).toUpperCase();
      const price = closingPrice(p.side, quote);
      const openPrice = num(p.open_price);
      const volume = num(p.volume) || 0;
      const fx = market.factor(quoteCcy, accountCcy);
      const priced = price != null && openPrice != null && fx != null;

      let profit = null;
      let notional = null;
      if (priced) {
        const direction = p.side === 'buy' ? 1 : -1;
        profit = (price - openPrice) * direction * contract * volume * fx;
        notional = price * contract * volume * fx;
        floating += profit;
        margin += notional / leverage;
      } else {
        anyUnpriced = true;
      }

      return {
        id: p.id,
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        volume,
        openPrice,
        currentPrice: price,
        profit: priced ? round2(profit) : null,
        swap: 0,
        margin: priced ? round2(notional / leverage) : null,
        currency: accountCcy,
        priceStatus: priced ? (quote ? quote.status : 'cached') : 'unavailable',
        source: quote ? quote.source : null,
      };
    });

    const balance = num(account.balance) || 0;
    const bonus = num(account.bonus) || 0;
    const equity = balance + bonus + floating;
    const freeMargin = equity - margin;
    const marginLevel = margin > 0 ? (equity / margin) * 100 : null;

    return {
      accountId: account.account_id,
      number: account.number,
      clientId: account.client_id,
      currency: accountCcy,
      leverage,
      status: account.status,
      balance: round2(balance),
      bonus: round2(bonus),
      credit: 0,
      floating: round2(floating),
      equity: round2(equity),
      margin: round2(margin),
      freeMargin: round2(freeMargin),
      marginLevel: marginLevel == null ? null : round2(marginLevel),
      positions: rows,
      positionsCount: rows.length,
      anyUnpriced,
      generatedAt: new Date().toISOString(),
    };
  });
}

/* Margen que consumiría una nueva posición, expresado en la divisa de la
   cuenta. Usa la misma fórmula que la valoración (notional convertido a la
   divisa de la cuenta entre el apalancamiento). Devuelve `null` si no se conoce
   el tipo de cambio, para que el motor no permita operar a ciegas. */
function marginForPosition(account, instrument, price, volume) {
  const accountCcy = String(account.currency || 'EUR').toUpperCase();
  const quoteCcy = String((instrument && instrument.ccy) || accountCcy).toUpperCase();
  const contract = instrument ? Number(instrument.contract_size) || 1 : 1;
  const fx = market.factor(quoteCcy, accountCcy);
  if (fx == null) return null;
  const notional = Number(price) * contract * Number(volume) * fx;
  const leverage = Number(account.leverage) || 100;
  return notional / leverage;
}

async function getSummary(accountId, actor) {
  const account = await accounts.findById(accountId);
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, account.client_id);
  const [summary] = await buildSummaries([account]);
  return summary;
}

async function listSummaries() {
  const rows = await accounts.list({ limit: 500, offset: 0 });
  const active = rows.filter((row) => !row.archived);
  return { items: await buildSummaries(active), generatedAt: new Date().toISOString() };
}

module.exports = { getSummary, listSummaries, buildSummaries, marginForPosition };
