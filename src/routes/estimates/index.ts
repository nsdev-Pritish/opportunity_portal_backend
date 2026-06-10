import { FastifyInstance } from 'fastify';
import { z } from 'zod';

// Recursively convert "" / null to undefined so Zod number fields accept blank frontend values
function stripEmpty(val: unknown): unknown {
  if (val === '' || val === null) return undefined;
  if (Array.isArray(val)) return val.map(stripEmpty);
  if (val && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, stripEmpty(v)])
    );
  }
  return val;
}

// Accept productDeveloperId (singular) as an alias for productDeveloperIds (plural)
function normalizeBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = { ...(body as Record<string, unknown>) };
  if (b.productDeveloperId !== undefined && b.productDeveloperIds === undefined) {
    const pd = b.productDeveloperId;
    b.productDeveloperIds = Array.isArray(pd) ? pd : [pd];
    delete b.productDeveloperId;
  }
  return b;
}
import {
  listEstimates,
  getEstimate,
  createEstimateWithItems,
  updateEstimateWithItems,
  deactivateEstimate,
  listDocumentNumbers,
  searchEstimatesAdvanced,
  listFailedSyncs,
  resyncEstimate,
  convertEstimateToOtb,
  listEstimateQuotes,
} from '../../services/estimate.service.js';
import { createEstimateAndConvertToOtb } from '../../services/otbConvert.service.js';

// ── Component schema — all detail fields shared by both item levels ──────────
// Components (Component Kit Items) carry purchase/landed/classification/packing
// data. This schema is reused for both top-level items and their components.
const ComponentSchema = z.object({
  // ── Line header ────────────────────────────────────────────────────────────
  id: z.number().int().positive().optional(),
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
  productClassEuId: z.number().int().positive().optional(),
  sustainabilityId: z.number().int().positive().optional(),
  componentKitItemId: z.number().int().positive().optional(),
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
  shippingGroupId: z.string().max(255).optional(),

  // ── Other Details (Vendor Only) ────────────────────────────────────────────
  exFactoryDate: z.string().optional(),
  vendorIncotermsId: z.number().int().positive().optional(),
  shipToVendorId: z.number().int().positive().optional(),
  shipToVendorAddrId: z.number().int().positive().optional(),
  notes: z.string().optional(),

  // ── Extended Line Fields ───────────────────────────────────────────────────
  lineComponents:       z.string().optional(),
  previousLineId:       z.number().int().positive().optional(),
  additionalFeeInfo:    z.string().optional(),
  countryOrigin:        z.string().max(100).optional(),
  itemClass:            z.string().max(255).optional(),   // UI field: class
  classItem:            z.string().max(255).optional(),
  vendorSku:            z.string().max(255).optional(),
  shippingInstruction:  z.string().optional(),
  paddingAmount:        z.string().optional(),            // numeric string e.g. "12.50"
  dutyMarkupAmount:     z.string().optional(),            // numeric string
  converted:            z.boolean().optional(),
  freightSelectedGroup: z.string().max(255).optional(),
  freightPol:           z.string().max(255).optional(),
  freightPod:           z.string().max(255).optional(),
  totalFreightCost:     z.string().optional(),            // numeric string
  freightCostPerUnit:   z.string().optional(),            // numeric string
  freightProvider:      z.string().max(255).optional(),
  freightNotes:         z.string().optional(),
  selected:             z.boolean().optional(),
  excludeFromPrint:     z.boolean().optional(),
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

  // Edit / Update fields
  statusId: z.number().int().positive().optional(),
  closedLostReasonId: z.number().int().positive().optional(),
  clientPursuitAlternativeId: z.number().int().positive().optional(),
  projectHoldDate: z.string().optional(),
  notesClosedLostReason: z.string().optional(),

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

// ── Phase 2: Header + line items ─────────────────────────────────────────────
const CreateEstimateSchema = EstimateHeaderSchema.extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
});
const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
});

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

  // POST /api/v1/estimates — Phase 2: header + optional line items
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { lineItems, ...headerData } = CreateEstimateSchema.parse(stripEmpty(normalizeBody(req.body)));
    const result = await createEstimateWithItems(headerData, lineItems ?? [], []);
    return reply.status(201).send(result);
  });

  // POST /api/v1/estimates/convert-to-otb — create a brand-new estimate AND convert it to a Quote.
  // Body = same shape as POST / (header + lineItems). Runs synchronously: creates locally,
  // syncs the estimate to NS, then creates the quote in NS, returning both with their NS ids.
  // Can take up to ~2 min (two sequential 60s NS calls).
  app.post<{ Body: unknown }>('/convert-to-otb', async (req, reply) => {
    const { lineItems, ...headerData } = CreateEstimateSchema.parse(stripEmpty(normalizeBody(req.body)));
    const result = await createEstimateAndConvertToOtb(headerData, lineItems ?? [], []);
    return reply.status(201).send(result);
  });

  // GET /api/v1/estimates/document-numbers — dropdown list (filtered)
  type DocNumQuery = {
    customerId?: string; customerName?: string;
    salesRepId?: string; salesRepName?: string;
    opsPartnerId?: string; opsPartnerName?: string;
    businessVerticalId?: string; businessVerticalName?: string;
    departmentId?: string; departmentName?: string;
    projectNameId?: string; projectName?: string;
    statuses?: string;
    productDeveloperId?: string; productDeveloperName?: string;
    likelyToCloseId?: string; likelyToCloseName?: string;
    expectedCloseDateFrom?: string; expectedCloseDateTo?: string;
    dateOfEntryFrom?: string; dateOfEntryTo?: string;
  };
  app.get<{ Querystring: DocNumQuery }>('/document-numbers', async (req) => {
    const q = req.query;
    return listDocumentNumbers({
      customerId:            q.customerId            ? parseInt(q.customerId)            : undefined,
      customerName:          q.customerName          || undefined,
      salesRepId:            q.salesRepId            ? parseInt(q.salesRepId)            : undefined,
      salesRepName:          q.salesRepName          || undefined,
      opsPartnerId:          q.opsPartnerId          ? parseInt(q.opsPartnerId)          : undefined,
      opsPartnerName:        q.opsPartnerName        || undefined,
      businessVerticalId:    q.businessVerticalId    ? parseInt(q.businessVerticalId)    : undefined,
      businessVerticalName:  q.businessVerticalName  || undefined,
      departmentId:          q.departmentId          ? parseInt(q.departmentId)          : undefined,
      departmentName:        q.departmentName        || undefined,
      projectNameId:         q.projectNameId         ? parseInt(q.projectNameId)         : undefined,
      projectName:           q.projectName           || undefined,
      statuses:              q.statuses              ? q.statuses.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      productDeveloperId:    q.productDeveloperId    ? parseInt(q.productDeveloperId)    : undefined,
      productDeveloperName:  q.productDeveloperName  || undefined,
      likelyToCloseId:       q.likelyToCloseId       ? parseInt(q.likelyToCloseId)       : undefined,
      likelyToCloseName:     q.likelyToCloseName     || undefined,
      expectedCloseDateFrom: q.expectedCloseDateFrom || undefined,
      expectedCloseDateTo:   q.expectedCloseDateTo   || undefined,
      dateOfEntryFrom:       q.dateOfEntryFrom       || undefined,
      dateOfEntryTo:         q.dateOfEntryTo         || undefined,
    });
  });

  // GET /api/v1/estimates/search — advanced filtered list
  type SearchQuery = DocNumQuery & {
    page?: string; limit?: string;
    estimateId?: string; documentNumber?: string;
  };
  app.get<{ Querystring: SearchQuery }>('/search', async (req) => {
    const q = req.query;

    // When a specific estimate is selected (by id or exact document number),
    // return the full estimate with line items + freight groups instead of a summary list
    if (q.estimateId) {
      return getEstimate(parseInt(q.estimateId));
    }

    return searchEstimatesAdvanced({
      page:                  parseInt(q.page  ?? '1'),
      limit:                 Math.min(parseInt(q.limit ?? '20'), 100),
      estimateId:            q.estimateId            ? parseInt(q.estimateId)            : undefined,
      documentNumber:        q.documentNumber        || undefined,
      customerId:            q.customerId            ? parseInt(q.customerId)            : undefined,
      customerName:          q.customerName          || undefined,
      salesRepId:            q.salesRepId            ? parseInt(q.salesRepId)            : undefined,
      salesRepName:          q.salesRepName          || undefined,
      opsPartnerId:          q.opsPartnerId          ? parseInt(q.opsPartnerId)          : undefined,
      opsPartnerName:        q.opsPartnerName        || undefined,
      businessVerticalId:    q.businessVerticalId    ? parseInt(q.businessVerticalId)    : undefined,
      businessVerticalName:  q.businessVerticalName  || undefined,
      departmentId:          q.departmentId          ? parseInt(q.departmentId)          : undefined,
      departmentName:        q.departmentName        || undefined,
      projectNameId:         q.projectNameId         ? parseInt(q.projectNameId)         : undefined,
      projectName:           q.projectName           || undefined,
      statuses:              q.statuses              ? q.statuses.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      productDeveloperId:    q.productDeveloperId    ? parseInt(q.productDeveloperId)    : undefined,
      productDeveloperName:  q.productDeveloperName  || undefined,
      likelyToCloseId:       q.likelyToCloseId       ? parseInt(q.likelyToCloseId)       : undefined,
      likelyToCloseName:     q.likelyToCloseName     || undefined,
      expectedCloseDateFrom: q.expectedCloseDateFrom || undefined,
      expectedCloseDateTo:   q.expectedCloseDateTo   || undefined,
      dateOfEntryFrom:       q.dateOfEntryFrom       || undefined,
      dateOfEntryTo:         q.dateOfEntryTo         || undefined,
    });
  });

  // GET /api/v1/estimates/sync-failures — list estimates where NS sync failed
  app.get('/sync-failures', async () => listFailedSyncs());

  // POST /api/v1/estimates/:id/resync — manually re-trigger NS sync
  app.post<{ Params: { id: string } }>('/:id/resync', async (req) =>
    resyncEstimate(parseInt(req.params.id)),
  );

  // POST /api/v1/estimates/:id/convert-to-otb — convert estimate to Quote in NS
  //   { "target": "new" }      → create a NEW quote covering the whole estimate
  //   { "target": "existing" } → add newly-added lines to the EXISTING quote
  app.post<{ Params: { id: string }; Body: unknown }>('/:id/convert-to-otb', async (req) => {
    const body = z.object({
      target: z.enum(['new', 'existing']).optional(),
    }).parse(stripEmpty(req.body ?? {}));
    return convertEstimateToOtb(parseInt(req.params.id), body);
  });

  // GET /api/v1/estimates/:id/quotes — list all quotes for an estimate
  app.get<{ Params: { id: string } }>('/:id/quotes', async (req) =>
    listEstimateQuotes(parseInt(req.params.id)),
  );

  // GET /api/v1/estimates/:id — full estimate with line items
  app.get<{ Params: { id: string } }>('/:id', async (req) =>
    getEstimate(parseInt(req.params.id)),
  );

  // PATCH /api/v1/estimates/:id — Phase 2: header + optional line items
  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req) => {
    const { lineItems, ...headerData } = UpdateEstimateSchema.parse(stripEmpty(normalizeBody(req.body)));
    return updateEstimateWithItems(parseInt(req.params.id), headerData, lineItems);
  });

  // DELETE /api/v1/estimates/:id — soft-delete
  app.delete<{ Params: { id: string } }>('/:id', async (req) =>
    deactivateEstimate(parseInt(req.params.id)),
  );
}
