'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor, requireManagerOrAdmin } = require('../middleware/authorize');
const service = require('../services/trading-account.service');

const accountIdParam = z.object({ accountId: z.string().regex(/^acc_[0-9a-f]{32}$/) });
const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/) });
const createSchema = z.object({
  clientId: z.string().regex(/^C\d{6}$/, 'clientId canonico requerido (C######)'),
  accountTypeId: z.string().regex(/^at-[a-z-]+$/),
  currency: z.string().length(3).optional(),
  leverage: z.number().int().positive().max(1000).optional(),
  status: z.enum(['pending', 'active']).optional(),
  requestId: z.string().regex(/^R-\d{4,}$/).optional(),
});

const listQuery = z.object({
  clientId: z.string().regex(/^C\d{6}$/).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'closed']).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  offset: z.string().optional(),
});

const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });
const archiveSchema = z.object({ archived: z.boolean().optional() });

const OPERATIVA = ['positions', 'orders', 'trades', 'transactions'];

module.exports = async function tradingAccountsRoutes(app) {
  /* Cuentas al instante: el personal del CRM (staff) y el propio cliente del
     Área de Cliente crean la cuenta sin aprobación. La solicitud con aprobación
     del Trading Manager queda solo para flujos heredados. */
  app.post(
    '/trading/accounts',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system', 'client'), validate({ body: createSchema })] },
    async (request, reply) => reply.code(201).send(await service.createAccount(request.body, request.actor))
  );

  app.get(
    '/trading/accounts',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ query: listQuery })] },
    async (request) => service.listAccounts(request.query)
  );

  app.get(
    '/trading/accounts/:accountId',
    { preHandler: [app.authenticate, validate({ params: accountIdParam })] },
    async (request) => service.getAccount(request.params.accountId, request.actor)
  );

  app.get(
    '/clients/:clientId/accounts',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => ({ items: await service.listByClient(request.params.clientId, request.actor) })
  );

  for (const kind of OPERATIVA) {
    app.get(
      `/trading/accounts/:accountId/${kind}`,
      { preHandler: [app.authenticate, validate({ params: accountIdParam })] },
      async (request) => ({ items: await service.getOperativa(request.params.accountId, kind, request.actor) })
    );
  }

  /* Administración de estado, archivado y borrado de cuentas. Reservado a
     administradores y managers (defensa en profundidad: el robot revalida el
     rol aunque la interfaz oculte el botón). */
  app.patch(
    '/trading/accounts/:accountId',
    { preHandler: [app.authenticate, requireManagerOrAdmin(), validate({ params: accountIdParam, body: statusSchema })] },
    async (request) => service.updateStatus(request.params.accountId, request.body.status, request.actor)
  );

  app.patch(
    '/trading/accounts/:accountId/archive',
    { preHandler: [app.authenticate, requireManagerOrAdmin(), validate({ params: accountIdParam, body: archiveSchema })] },
    async (request) => service.setArchived(request.params.accountId, request.body.archived !== false, request.actor)
  );

  app.delete(
    '/trading/accounts/:accountId',
    { preHandler: [app.authenticate, requireManagerOrAdmin(), validate({ params: accountIdParam })] },
    async (request) => service.deleteAccount(request.params.accountId, request.actor)
  );
};
