'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/valuation.service');
const market = require('../services/market-data.service');

const accountIdParam = z.object({ accountId: z.string().regex(/^acc_[0-9a-f]{32}$/) });

module.exports = async function tradingSummaryRoutes(app) {
  /* Valoración en vivo de UNA cuenta (patrimonio, margen y P/L flotante con
     precios reales). La usan la Terminal y el Área de cliente. */
  app.get(
    '/trading/accounts/:accountId/summary',
    { preHandler: [app.authenticate, validate({ params: accountIdParam })] },
    async (request) => service.getSummary(request.params.accountId, request.actor)
  );

  /* Valoración agregada de TODAS las cuentas activas. La usa el Manager para el
     cuadro de mando y la lista de cuentas. */
  app.get(
    '/trading/summary',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system')] },
    async () => service.listSummaries()
  );

  /* Cinta de precios compartida. El robot devuelve su cotización ya cacheada de
     los símbolos pedidos; la Terminal, el Manager y el Área de cliente leen de
     aquí, de modo que TODAS muestran el mismo precio a la vez (una sola fuente,
     una sola caché, un solo reloj). Un símbolo sin cotización no aparece en la
     respuesta: equivale a «sin precio» y nunca se rellena con un valor simulado. */
  app.get(
    '/trading/quotes',
    { preHandler: [app.authenticate] },
    async (request) => {
      const raw = String((request.query && request.query.symbols) || '');
      const symbols = raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 80);
      const items = symbols.length
        ? await market.getQuotes(symbols.map((symbol) => ({ symbol })))
        : {};
      return { items, generatedAt: new Date().toISOString() };
    }
  );

  /* Velas OHLC compartidas para las gráficas. Las apps no llaman al proveedor
     por su cuenta: piden las velas al robot, que las cachea. Así la Terminal,
     el Manager y la web pública cargan las MISMAS velas sin agotar cuotas y sin
     el límite de peticiones que dejaba gráficas en blanco. */
  app.get(
    '/trading/candles',
    { preHandler: [app.authenticate] },
    async (request) => {
      const query = request.query || {};
      const symbol = String(query.symbol || '').split(',')[0].trim().toUpperCase();
      const interval = String(query.interval || 'H1');
      const outputsize = Number.parseInt(query.outputsize, 10) || 500;
      const data = symbol ? await market.getCandles(symbol, interval, outputsize) : null;
      if (!data) {
        return { symbol, interval: interval.toUpperCase(), candles: [], source: null, generatedAt: new Date().toISOString() };
      }
      return data;
    }
  );
};
