import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listLineItems, addLineItem, bulkInsertLineItems, updateLineItem, deleteLineItem } from '../../services/lineItem.service.js';
import { recalculateAndSave } from '../../services/calculation.service.js';

const LineItemSchema = z.object({
  itemTypeId: z.number().int().optional(), shortDescription: z.string().max(500).optional(),
  color: z.string().max(20).optional(),
  vendorId: z.number().int().optional(), quantity: z.string().optional(),
  sellPricePerUnit: z.string().optional(), description: z.string().optional(),
  factoryId: z.number().int().optional(), vendorCurrencyId: z.number().int().optional(),
  factoryCostPerUnit: z.string().optional(), packingCostPerUnit: z.string().optional(),
  sampleFees: z.string().optional(), otherPerUnit: z.string().optional(),
  freightPerUnit: z.string().optional(), dutyPct: z.string().optional(),
  tariffPct: z.string().optional(), tariffMuPct: z.string().optional(),
  otherCostPct: z.string().optional(), paddingPct: z.string().optional(),
  productClassId: z.number().int().optional(), sustainabilityId: z.number().int().optional(),
  productClassEuId: z.number().int().optional(),
  classId: z.number().int().optional(),
  htsCode: z.string().max(20).optional(), countryOfOrigin: z.string().max(100).optional(),
  countryOfDest: z.enum(['US','EU']).optional(),
  unitsPerCarton: z.number().int().optional(), dimLCm: z.string().optional(),
  dimWCm: z.string().optional(), dimHCm: z.string().optional(),
  weightKgPerCarton: z.string().optional(), shippingGroupId: z.string().max(255).optional(),
  exFactoryDate: z.string().optional(), vendorIncotermsId: z.number().int().optional(),
  shipToVendorId: z.number().int().optional(), notes: z.string().optional(),
  exclude: z.boolean().optional(), pickupExwFob: z.string().optional(),
  oceanDdp: z.string().optional(), airDdp: z.string().optional(),
  freightModeSelection: z.string().max(20).optional(),
});

export default async function lineItemRoutes(app: FastifyInstance) {
  app.get('/', async (req: any) => listLineItems(parseInt(req.params.estimateId)));
  app.post<{ Body: unknown }>('/', async (req: any, reply) => {
    const data = LineItemSchema.parse(req.body);
    return reply.status(201).send(await addLineItem(parseInt(req.params.estimateId), data));
  });
  app.post<{ Body: { items: unknown[] } }>('/bulk', async (req: any, reply) => {
    const { items } = z.object({ items: z.array(LineItemSchema).max(400) }).parse(req.body);
    return reply.status(201).send(await bulkInsertLineItems(parseInt(req.params.estimateId), items));
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req: any) => {
    const data = LineItemSchema.partial().parse(req.body);
    return updateLineItem(parseInt(req.params.id), parseInt(req.params.estimateId), data);
  });
  app.post<{ Params: { id: string } }>('/:id/recalculate', async (req: any) =>
    recalculateAndSave(parseInt(req.params.id))
  );
  app.delete<{ Params: { id: string } }>('/:id', async (req: any) =>
    deleteLineItem(parseInt(req.params.id), parseInt(req.params.estimateId))
  );
}
