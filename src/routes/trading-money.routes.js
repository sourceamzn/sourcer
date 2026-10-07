'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/trading-money.service');

const accountIdParam = z.object({ accountId: z.string().regex(/^acc_[0-9a-f]{32}$/) });
const positiveAmount = z.number().positive();
const movementSchema = z.object({
  amount: positiveAmount,
  method: z.string().max(60).optional(),
  reference: z.string().max(120).optional(),
  comment: z.string().max(280).optional(),
  idempotencyKey: z.string().max(120).optional(),
});
const bonusSchema = z.object({
  amount: positiveAmount,
  reason: z.string().max(280).optional(),
});
const adjustSchema = z.object({
  amount: z.number().refine((value) => value !== 0, 'El importe no puede ser cero'),
  reason: z.string().max(280).optional(),
});
const transferSchema = z
  .object({
    toNumber: z.number().int().positive().optional(),
    toAccountId: z.string().regex(/^acc_[0-9a-f]{32}$/).optional(),
    amount: positiveAmount,
    comment: z.string().max(280).optional(),
    idempotencyKey: z.string().max(120).optional(),
  })
  .refine((data) => Boolean(data.toNumber || data.toAccountId), {
    message: 'Indica la cuenta destino',
    path: ['toNumber'],
  });

const STAFF = ['tm', 'staff', 'system'];

module.exports = async function tradingMoneyRoutes(app) {
  app.post(
    '/trading/accounts/:accountId/deposit',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: movementSchema })] },
    async (request, reply) => reply.code(201).send(await service.deposit(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/withdraw',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: movementSchema })] },
    async (request, reply) => reply.code(201).send(await service.withdraw(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/bonus',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: bonusSchema })] },
    async (request, reply) => reply.code(201).send(await service.addBonus(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/bonus/remove',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: bonusSchema })] },
    async (request, reply) => reply.code(201).send(await service.removeBonus(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/transfer',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: transferSchema })] },
    async (request, reply) => reply.code(201).send(await service.transfer(request.params.accountId, request.body, request.actor))
  );

  app.post(
    '/trading/accounts/:accountId/adjust',
    { preHandler: [app.authenticate, requireActor(...STAFF), validate({ params: accountIdParam, body: adjustSchema })] },
    async (request, reply) => reply.code(201).send(await service.adjust(request.params.accountId, request.body, request.actor))
  );
};
