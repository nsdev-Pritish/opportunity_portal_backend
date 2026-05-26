import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listEstimates,
  getEstimate,
  createEstimateWithItems,
  updateEstimateWithItems,
  deactivateEstimate,
} from '../../services/estimate.service.js';

// ── Freight Group schema (mirrors estimate_freight_groups columns) ────────────
const FreightGroupSchema = z.object({
  id: z.number().int().positive().optional(),           // present on update
  groupName: z.string().max(255).optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  chosenType: z.enum(['LCL', 'FCL', 'AIR', 'CUSTOM']).optional(),
  lclRateId: z.number().int().positive().optional(),
  fclRateId: z.number().int().positive().optional(),
  airRateId: z.number().int().positive().optional(),
  customProvider: z.string().max(255).optional(),
  customFreightCost: z.string().optional(),
  customNotes: z.string().optional(),
  pol: z.string().max(255).optional(),
  pod: z.string().max(255).optional(),
  totalCartons: z.number().int().nonnegative().optional(),
  totalCbm: z.string().optional(),
  chargeableWeightKg: z.string().optional(),
  freightCost: z.string().optional(),
  freightCostPerUnit: z.string().optional(),
});

// ── Component schema — all detail fields shared by both item levels ──────────
// Components (Component Kit Items) carry purchase/landed/classification/packing
// data. This schema is reused for both top-level items and their components.
const ComponentSchema = z.object({
  // ── Line header ────────────────────────────────────────────────────────────
  itemTypeId: z.number().int().positive().optional(),
  shortDescription: z.string().max(500).optional(),
  vendorId: z.number().int().positive().optional(),
  quantity: z.string().optional(),
  sellPricePerUnit: z.string().optional(),
  skuMarginPct: z.string().optional(),
  salesAmount: z.string().optional(),
  pickupExwFob: z.string().optional(),
  oceanDdp: z.string().optional(),
  airDdp: z.string().optional(),
  exclude: z.boolean().optional(),

  // ── Purchase Information ───────────────────────────────────────────────────
  description: z.string().optional(),
  factoryId: z.number().int().positive().optional(),
  vendorCurrencyId: z.number().int().positive().optional(),
  factoryCostPerUnit: z.string().optional(),
  packingCostPerUnit: z.string().optional(),
  sampleFees: z.string().optional(),
  otherPerUnit: z.string().optional(),

  // ── Landed Cost ────────────────────────────────────────────────────────────
  landedCostPerUnit: z.string().optional(),
  extendedLandedCost: z.string().optional(),
  freightPerUnit: z.string().optional(),
  dutyPct: z.string().optional(),
  tariffPct: z.string().optional(),
  tariffMuPct: z.string().optional(),
  otherCostPct: z.string().optional(),
  usdFactoryCost: z.string().optional(),
  paddingPct: z.string().optional(),

  // ── Classification ─────────────────────────────────────────────────────────
  productClassId: z.number().int().positive().optional(),
  sustainabilityId: z.number().int().positive().optional(),
  htsCode: z.string().max(20).optional(),
  countryOfOrigin: z.string().max(100).optional(),
  countryOfDest: z.enum(['US', 'EU']).optional(),

  // ── Packing Details ────────────────────────────────────────────────────────
  unitsPerCarton: z.number().int().positive().optional(),
  dimLCm: z.string().optional(),
  dimWCm: z.string().optional(),
  dimHCm: z.string().optional(),
  weightKgPerCarton: z.string().optional(),
  totalCartons: z.number().int().nonnegative().optional(),
  cbmPerCarton: z.string().optional(),
  totalCbm: z.string().optional(),
  chargeableWeightKg: z.string().optional(),
  shippingGroupId: z.number().int().positive().optional(),

  // ── Other Details (Vendor Only) ────────────────────────────────────────────
  exFactoryDate: z.string().optional(),
  vendorIncotermsId: z.number().int().positive().optional(),
  shipToVendorId: z.number().int().positive().optional(),
  shipToVendorAddrId: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// ── Line item schema — top-level item + optional nested components ──────────
// When itemType is "Quote Kit Item", components[] holds the Component Kit Items.
// Each component carries its own purchase/landed/packing detail fields.
const LineItemSchema = ComponentSchema.extend({
  components: z.array(ComponentSchema).max(50).optional(),
});

// ── Estimate header schema ──────────────────────────────────────────────────
const EstimateHeaderSchema = z.object({
  // Primary Information
  subsidiaryId: z.number().int().positive().optional(),
  customerId: z.number().int().positive(),
  customerContactId: z.number().int().positive().optional(),
  customerPo: z.string().max(100).optional(),
  projectNameId: z.number().int().positive().optional(),  // dropdown selection
  projectName: z.string().min(1).max(255).optional(),     // free-text fallback
  projectTypeId: z.number().int().positive().optional(),
  expectedCloseDate: z.string().optional(),
  promiseDate: z.string().optional(),
  likelyToCloseId: z.number().int().positive().optional(),
  sellCurrencyId: z.number().int().positive().optional(),
  projectedTotalAmt: z.string().optional(),
  estimatedQty: z.number().int().nonnegative().optional(),

  // Classification
  departmentId: z.number().int().positive().optional(),
  salesChannelId: z.number().int().positive().optional(),
  businessVerticalId: z.number().int().positive().optional(),
  businessTypeId: z.number().int().positive().optional(),
  compliancePartnerId: z.number().int().positive().optional(),
  acctManagerId: z.number().int().positive().optional(),
  productDeveloperIds: z.array(z.number().int().positive()).optional(),
  hkPartnerId: z.number().int().positive().optional(),
  opsPartner1Id: z.number().int().positive().optional(),
  opsPartner2Id: z.number().int().positive().optional(),
  deckRequest: z.boolean().optional(),
  artSetupRequest: z.boolean().optional(),
  pkgDeckRequest: z.boolean().optional(),
  pkgArtSetupRequest: z.boolean().optional(),

  // Client Shipping & Billing
  clientIncotermsId: z.number().int().positive().optional(),
  clientShipMethodId: z.number().int().positive().optional(),
  shippingAddressId: z.number().int().positive().optional(),  // Shipping Address dropdown
  shipTo: z.string().optional(),                              // Ship To textarea (formatted address text)
  billingAddressId: z.number().int().positive().optional(),   // Billing Address dropdown
  billTo: z.string().optional(),                              // Bill To textarea (formatted address text)

  // Additional Information
  sampleOnlyOrder: z.boolean().optional(),            // Sample Only Order checkbox
  reOrder: z.boolean().optional(),                    // Re-Order checkbox
  bibleLink: z.string().max(1000).optional(),         // Bible Link text
  memo: z.string().optional(),                        // Memo textarea
  attachments: z.array(z.object({                     // File upload metadata
    name: z.string(),
    url: z.string(),
    size: z.number(),
    type: z.string(),
  })).optional(),
});

// ── Phase 1: Body-level only ─────────────────────────────────────────────────
const CreateEstimateSchema = EstimateHeaderSchema;
const UpdateEstimateSchema = EstimateHeaderSchema.partial();

// Phase 2 – uncomment to add line items (replace Phase 1 schemas above):
// const CreateEstimateSchema = EstimateHeaderSchema.extend({
//   lineItems: z.array(LineItemSchema).max(400).optional(),
// });
// const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
//   lineItems: z.array(LineItemSchema).max(400).optional(),
// });

// Phase 3 – uncomment to add freight groups too (replace Phase 2 schemas above):
// const CreateEstimateSchema = EstimateHeaderSchema.extend({
//   lineItems: z.array(LineItemSchema).max(400).optional(),
//   freightGroups: z.array(FreightGroupSchema).max(50).optional(),
// });
// const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
//   lineItems: z.array(LineItemSchema).max(400).optional(),
//   freightGroups: z.array(FreightGroupSchema).max(50).optional(),
// });

// ── Routes ──────────────────────────────────────────────────────────────────

export default async function estimateRoutes(app: FastifyInstance) {

  // GET /api/v1/estimates — paginated list
  app.get<{
    Querystring: { page?: string; limit?: string; search?: string; status?: string; customerId?: string };
  }>('/', async (req) =>
    listEstimates({
      page: parseInt(req.query.page ?? '1'),
      limit: parseInt(req.query.limit ?? '20'),
      search: req.query.search,
      status: req.query.status,
      customerId: req.query.customerId ? parseInt(req.query.customerId) : undefined,
    }),
  );

  // POST /api/v1/estimates — Phase 1: body-level fields only
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const headerData = CreateEstimateSchema.parse(req.body);
    const result = await createEstimateWithItems(headerData, [], []);
    return reply.status(201).send(result);
  });

  // GET /api/v1/estimates/:id — full estimate with line items
  app.get<{ Params: { id: string } }>('/:id', async (req) =>
    getEstimate(parseInt(req.params.id)),
  );

  // PATCH /api/v1/estimates/:id — Phase 1: body-level fields only
  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req) => {
    const headerData = UpdateEstimateSchema.parse(req.body);
    return updateEstimateWithItems(parseInt(req.params.id), headerData);
  });

  // DELETE /api/v1/estimates/:id — soft-delete
  app.delete<{ Params: { id: string } }>('/:id', async (req) =>
    deactivateEstimate(parseInt(req.params.id)),
  );
}
