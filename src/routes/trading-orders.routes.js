'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const service = require('../services/trading-engine.service');

const accountIdParam = z.object({ accountId: z.string().regex(/^acc_[0-9a-f]{32}$/) });
const positionIdParam = z.object({ positionId: z.string().regex(/^p_[0-9a-f]{32}$/) });
const orderIdParam = z.object({ orderId: z.string().regex(/^o_[0-9a-f]{32}$/) });

const priceish = z.union([z.number(), z.string(), z.null()]).optional();
const optionalNumber = z.union([z.number().positive(), z.null()]).optional();

const openSchema = z.object({
  symbol: z.string().min(2).max(16),
  side: z.enum(['buy', 'sell']),
  volume: z.number().positive(),
  price: optionalNumber,
  openPrice: optionalNumber,
  sl: priceish,
  tp: priceish,
  reason: z.string().max(280).optional(),
});

const orderSchema = z.object({
  symbol: z.string().min(2).max(16),
  type: z.enum(['market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']),
  price: optionalNumber,
  volume: z.number().positive(),
  sl: priceish,
  tp: priceish,
  reason: z.string().max(280).optional(),
});

const modifySchema = z.object({
  sl: priceish,
  tp: priceish,
  openPrice: priceish,
  reason: z.string().max(280).optional(),
});

const orderModifySchema = z.object({
  price: priceish,
  sl: priceish,
  tp: priceish,
  reason: z.string().max(280).optional(),
});

const closeSchema = z.object({
  volume: optionalNumber,
  price: optionalNumber,
  closePrice: optionalNumber,
  reason: z.string().max(280).optional(),
});

module.exports = async function tradingOrdersRoutes(app) {
  app.post(
    '/trading/accounts/:accountId/positions',
    { preHandler: [app.authenticate, validate({ params: accountIdParam, body: openSchema })] },
    async (request, reply) => reply.code(201).send(await service.openPosition(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/orders',
    { preHandler: [app.authenticate, validate({ params: accountIdParam, body: orderSchema })] },
    async (request, reply) => reply.code(201).send(await service.placeOrder(request.params.accountId, request.body, request.actor))
  );

  app.patch(
    '/trading/positions/:positionId',
    { preHandler: [app.authenticate, validate({ params: positionIdParam, body: modifySchema })] },
    async (request) => service.modifyPosition(request.params.positionId, request.body, request.actor)
  );

  app.patch(
    '/trading/orders/:orderId',
    { preHandler: [app.authenticate, validate({ params: orderIdParam, body: orderModifySchema })] },
    async (request) => service.modifyOrder(request.params.orderId, request.body, request.actor)
  );

  app.post(
    '/trading/positions/:positionId/close',
    { preHandler: [app.authenticate, validate({ params: positionIdParam, body: closeSchema })] },
    async (request) => service.closePosition(request.params.positionId, request.body, request.actor)
  );

  app.delete(
    '/trading/orders/:orderId',
    { preHandler: [app.authenticate, validate({ params: orderIdParam })] },
    async (request) =>
      service.cancelOrder(
        request.params.orderId,
        { reason: (request.body && request.body.reason) || (request.query && request.query.reason) || null },
        request.actor
      )
  );
};
