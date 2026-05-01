import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listEstimates, getEstimate, createEstimate, updateEstimate, deactivateEstimate } from '../../services/estimate.service.js';

const CreateSchema = z.object({
  customerId: z.number().int().positive(),
  projectName: z.string().min(1).max(255),
  customerContactId: z.number().int().optional(),
  customerPo: z.string().max(100).optional(),
  projectTypeId: z.number().int().optional(),
  expectedCloseDate: z.string().optional(),
  promiseDate: z.string().optional(),
  likelyToCloseId: z.number().int().optional(),
  sellCurrencyId: z.number().int().optional(),
  projectedTotalAmt: z.string().optional(),
  estimatedQty: z.number().int().optional(),
  departmentId: z.number().int().optional(),
  salesChannelId: z.number().int().optional(),
  businessVerticalId: z.number().int().optional(),
  businessTypeId: z.number().int().optional(),
  compliancePartnerId: z.number().int().optional(),
  acctManagerId: z.number().int().optional(),
  productDeveloperId: z.number().int().optional(),
  hkPartnerId: z.number().int().optional(),
  opsPartner1Id: z.number().int().optional(),
  opsPartner2Id: z.number().int().optional(),
  deckRequest: z.boolean().optional(),
  artSetupRequest: z.boolean().optional(),
  pkgDeckRequest: z.boolean().optional(),
  pkgArtSetupRequest: z.boolean().optional(),
  clientIncotermsId: z.number().int().optional(),
  clientShipMethodId: z.number().int().optional(),
  shippingAddressId: z.number().int().optional(),
  billingAddressId: z.number().int().optional(),
  sampleOnlyOrder: z.boolean().optional(),
  reOrder: z.boolean().optional(),
  bibleLink: z.string().optional(),
  memo: z.string().optional(),
});

export default async function estimateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get<{ Querystring: { page?: string; limit?: string; search?: string; status?: string; customerId?: string } }>('/', async (req) =>
    listEstimates({ page: parseInt(req.query.page ?? '1'), limit: parseInt(req.query.limit ?? '20'), search: req.query.search, status: req.query.status, customerId: req.query.customerId ? parseInt(req.query.customerId) : undefined }),
  );

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const data = CreateSchema.parse(req.body);
    const record = await createEstimate({ ...data, createdBy: req.user.id });
    return reply.status(201).send(record);
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => getEstimate(parseInt(req.params.id)));

  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req) => {
    const data = CreateSchema.partial().parse(req.body);
    return updateEstimate(parseInt(req.params.id), { ...data, updatedBy: req.user.id });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => deactivateEstimate(parseInt(req.params.id)));
}
