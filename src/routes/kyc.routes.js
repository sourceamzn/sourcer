'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor, assertClientAccess } = require('../middleware/authorize');
const kyc = require('../services/kyc.service');

const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/, 'clientId canonico requerido (C######)') });
const docIdParam = z.object({ docId: z.string().min(1).max(40) });

const createBody = z.object({
  type: z.enum(['selfie', 'id', 'source_funds', 'proof_address']),
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['received', 'approved', 'rejected']).optional(),
  note: z.string().max(2000).optional(),
});

const reviewBody = z.object({
  status: z.enum(['received', 'approved', 'rejected']),
  note: z.string().max(2000).optional(),
});

const listQuery = z.object({
  clientId: z.string().max(40).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const contentBody = z.object({
  mime: z.string().min(3).max(80),
  contentBase64: z.string().min(1).max(16 * 1024 * 1024),
});

module.exports = async function kycRoutes(app) {
  app.get(
    '/clients/:clientId/documents',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => {
      assertClientAccess(request.actor, request.params.clientId);
      return { items: await kyc.listClientDocuments(request.params.clientId) };
    }
  );

  app.post(
    '/clients/:clientId/documents',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ params: clientIdParam, body: createBody })] },
    async (request, reply) => reply.code(201).send(await kyc.createDocument(request.params.clientId, request.body, request.actor))
  );

  app.get(
    '/kyc/documents',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ query: listQuery })] },
    async (request) => kyc.listDocuments(request.query)
  );

  /* Contenido del documento: se guarda cifrado en reposo (AES-256-GCM) y se
     sirve unicamente como JSON/base64 con Cache-Control no-store; nunca se
     renderiza inline, de modo que un archivo malicioso no se ejecuta en el
     dominio de la aplicacion. */
  app.post(
    '/kyc/documents/:docId/content',
    {
      bodyLimit: 14 * 1024 * 1024,
      preHandler: [
        app.authenticate,
        requireActor('staff', 'system'),
        validate({ params: docIdParam, body: contentBody }),
      ],
    },
    async (request, reply) =>
      reply.code(201).send(await kyc.uploadDocumentContent(request.params.docId, request.body, request.actor))
  );

  app.get(
    '/kyc/documents/:docId/content',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        validate({ params: docIdParam }),
      ],
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Disposition', 'attachment');
      return kyc.getDocumentContent(request.params.docId, request.actor);
    }
  );

  app.patch(
    '/kyc/documents/:docId',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ params: docIdParam, body: reviewBody })] },
    async (request) => kyc.reviewDocument(request.params.docId, request.body, request.actor)
  );

  app.delete(
    '/kyc/documents/:docId',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ params: docIdParam })] },
    async (request) => kyc.deleteDocument(request.params.docId, request.actor)
  );
};
