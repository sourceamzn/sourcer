'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const accountTypeService = require('../services/account-type.service');

const param = z.object({ accountTypeId: z.string().regex(/^at-[a-z-]+$/) });

module.exports = async function accountTypesRoutes(app) {
  app.get('/account-types', { preHandler: [app.authenticate] }, async () => accountTypeService.listAccountTypes());

  app.get(
    '/account-types/:accountTypeId',
    { preHandler: [app.authenticate, validate({ params: param })] },
    async (request) => accountTypeService.getAccountType(request.params.accountTypeId)
  );
};
