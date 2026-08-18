import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uploadToR2 } from '../../services/r2.service.js';
import { AppError } from '../../utils/errors.js';

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
  updateEstimatesPipelineFields,
  deactivateEstimate,
  deleteEstimate,
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
  color: z.string().max(20).optional(),
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
  image: z.object({ name: z.string(), url: z.string().url(), size: z.number(), type: z.string() }).optional(),
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
  classId: z.number().int().positive().optional(),
  sustainabilityId: z.number().int().positive().optional(),
  componentKitItemId: z.number().int().positive().optional(),
  htsCode: z.string().max(20).optional(),
  countryOfOrigin: z.string().max(100).optional(),
  countryOfDest: z.enum(['US', 'EU']).optional(),

  // ── Packing Details ────────────────────────────────────────────────────────
  unitsPerCarton: z.number().int().nonnegative().optional(),   // allow 0 (blank/not filled)
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
  freightModeSelection: z.string().max(20).optional(),
  trueTariff:           z.string().max(255).optional(),
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
  adjustedPipeline: z.string().optional(),   // Adjusted Pipeline currency amount → estimates.adjusted_pipeline

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

  // Twelve Pays — YES/NO dropdowns; sync to NetSuite custom body fields
  twelvePaysImportFrt: z.enum(['YES', 'NO']).optional(),   // custbody_twelve_pays_import_frt
  twelvePaysShipToCust: z.enum(['YES', 'NO']).optional(),  // custbody_twelve_pays_ship_to_cust

  // Divisional Budget — conditional field, shown by the frontend for L'Oréal
  // customers only; syncs to NetSuite custbody_divisional_budget.
  // Send divisionalBudgetId (dropdown row from /api/v1/master/divisional_budgets);
  // divisionalBudget is the legacy free-text form, still accepted. When only the
  // id is sent the label is resolved from the master list on the way to NetSuite.
  divisionalBudgetId: z.number().int().positive().optional(),  // FK → divisional_budgets.id
  divisionalBudget: z.string().max(255).optional(),        // custbody_divisional_budget

  attachments: z.array(z.object({                     // File upload metadata
    name: z.string(),
    url: z.string(),
    size: z.number(),
    type: z.string(),
  })).optional(),
});

// ── Freight group schema ──────────────────────────────────────────────────────
// A freight group bundles a set of line items under one shipping decision. itemIds
// reference the line items in the group by their 0-based index in the lineItems array
// of the same request (the only stable key available on create, before DB ids exist).
// Numeric values are sent as strings to match the rest of the estimate payload.
const FreightGroupSchema = z.object({
  groupName:           z.string().max(255).optional(),
  freightModeSelected: z.enum(['OCEAN_LCL', 'OCEAN_FCL', 'AIR', 'CUSTOM']).optional(),  // Freight Mode Selected
  drayageId:           z.number().int().positive().nullable().optional(),  // FK → drayage.id (freight group → one drayage)
  itemIds:             z.array(z.number().int().nonnegative()).optional(),  // indices into lineItems
  numItems:       z.number().int().nonnegative().optional(),
  totalCartons:   z.number().int().nonnegative().optional(),
  totalCbm:       z.string().optional(),
  totalWeight:    z.string().optional(),

  oceanLclTotal:   z.string().optional(),
  oceanLclPerUnit: z.string().optional(),
  oceanLclPol:     z.string().max(255).optional(),
  oceanLclPod:     z.string().max(255).optional(),

  oceanFclTotal:   z.string().optional(),
  oceanFclPerUnit: z.string().optional(),
  oceanFclPol:     z.string().max(255).optional(),
  oceanFclPod:     z.string().max(255).optional(),

  airTotal:   z.string().optional(),
  airPerUnit: z.string().optional(),
  airPol:     z.string().max(255).optional(),
  airPod:     z.string().max(255).optional(),

  customTotal:    z.string().optional(),
  customPerUnit:  z.string().optional(),
  customProvider: z.string().max(255).optional(),
  customNotes:    z.string().optional(),
});

// ── Header + line items + freight groups ─────────────────────────────────────
const CreateEstimateSchema = EstimateHeaderSchema.extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
  freightGroups: z.array(FreightGroupSchema).max(50).optional(),
});
const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
  freightGroups: z.array(FreightGroupSchema).max(50).optional(),
});

// ── Pipeline grid bulk-update schema ─────────────────────────────────────────
// The Pipeline screen edits a narrow set of header cells inline across many rows.
// This schema deliberately allows ONLY those fields — Zod strips everything else —
// so the bulk endpoint can never touch line items, freight, or other header fields.
// All fields optional (partial cell edits); each item carries its own estimate id.
const PipelineFieldsSchema = z.object({
  acctManagerId:       z.number().int().positive().optional(),  // Sales Rep
  opsPartner1Id:       z.number().int().positive().optional(),  // Ops Partner
  productDeveloperIds: z.array(z.number().int().positive()).optional(),  // Product Dev (multi)
  projectedTotalAmt:   z.string().optional(),                   // Projected
  estimatedQty:        z.number().int().nonnegative().optional(),  // Est. qty
  expectedCloseDate:   z.string().optional(),                   // Exp. close
  promiseDate:         z.string().optional(),                   // Promise
  salesChannelId:      z.number().int().positive().optional(),  // Channel
  businessVerticalId:  z.number().int().positive().optional(),  // Category
  likelyToCloseId:     z.number().int().positive().optional(),  // Likely-to-close
  esStatusId:          z.number().int().positive().optional(),  // ES Status
});
const PipelineBulkSchema = z.object({
  items: z.array(PipelineFieldsSchema.extend({ id: z.number().int().positive() })).min(1).max(200),
});

// ── Multipart helper ─────────────────────────────────────────────────────────
// Parses a multipart/form-data request into a plain object.
// Expects:  data (Text) = JSON string of estimate fields
//           file (File, optional, repeatable) = attachments to upload to R2
async function parseMultipartEstimate(req: FastifyRequest): Promise<Record<string, unknown>> {
  const parts = req.parts();
  let raw: Record<string, unknown> = {};
  const uploaded: Array<{ name: string; url: string; size: number; type: string }> = [];
  let lineItemImage: { name: string; url: string; size: number; type: string } | null = null;
  let lineItemImageId: number | null = null;

  for await (const part of parts) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      if (buf.length === 0) continue;
      if (part.fieldname === 'lineItemImage') {
        lineItemImage = await uploadToR2(buf, part.filename ?? 'file', part.mimetype);
      } else {
        uploaded.push(await uploadToR2(buf, part.filename ?? 'file', part.mimetype));
      }
    } else if (part.fieldname === 'data') {
      try { raw = JSON.parse(part.value as string); }
      catch { throw new AppError('Invalid JSON in "data" field', 400, 'INVALID_JSON'); }
    } else if (part.fieldname === 'lineItemImageId') {
      lineItemImageId = parseInt(part.value as string);
    }
  }

  if (uploaded.length > 0) {
    const existing = Array.isArray(raw.attachments) ? (raw.attachments as unknown[]) : [];
    raw.attachments = [...existing, ...uploaded];
  }

  if (lineItemImage && lineItemImageId) {
    const lineItems = Array.isArray(raw.lineItems) ? (raw.lineItems as Record<string, unknown>[]) : [];
    const li = lineItems.find(item => Number(item.id) === lineItemImageId);
    if (li) {
      li.image = lineItemImage;
    } else {
      // line item not in body yet — create a minimal entry so the image gets saved
      lineItems.push({ id: lineItemImageId, image: lineItemImage });
      raw.lineItems = lineItems;
    }
  }

  return raw;
}

// ── Query helpers ─────────────────────────────────────────────────────────────
// Filters accept comma-separated values (e.g. customerId=12,15,20). A single value
// still parses to a one-element array, so callers sending one value keep working.
const csvInt = (v?: string): number[] | undefined => {
  if (!v) return undefined;
  const arr = v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return arr.length ? arr : undefined;
};
const csvStr = (v?: string): string[] | undefined => {
  if (!v) return undefined;
  const arr = v.split(',').map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
};

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

  // POST /api/v1/estimates — accepts JSON or multipart/form-data (data field + file fields)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const raw = req.headers['content-type']?.startsWith('multipart/form-data')
      ? await parseMultipartEstimate(req)
      : req.body as Record<string, unknown>;
    const { lineItems, freightGroups, ...headerData } = CreateEstimateSchema.parse(stripEmpty(normalizeBody(raw)));
    const result = await createEstimateWithItems(headerData, lineItems ?? [], freightGroups ?? []);
    return reply.status(201).send(result);
  });

  // POST /api/v1/estimates/convert-to-otb — create a brand-new estimate AND convert it to a Quote.
  // Body = same shape as POST / (header + lineItems). Runs synchronously: creates locally,
  // syncs the estimate to NS, then creates the quote in NS, returning both with their NS ids.
  // Can take up to ~2 min (two sequential 60s NS calls).
  app.post<{ Body: unknown }>('/convert-to-otb', async (req, reply) => {
    const { lineItems, freightGroups, ...headerData } = CreateEstimateSchema.parse(stripEmpty(normalizeBody(req.body)));
    const result = await createEstimateAndConvertToOtb(headerData, lineItems ?? [], freightGroups ?? []);
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
    esStatusId?: string;
    expectedCloseDateFrom?: string; expectedCloseDateTo?: string;
    dateOfEntryFrom?: string; dateOfEntryTo?: string;
  };
  app.get<{ Querystring: DocNumQuery }>('/document-numbers', async (req) => {
    const q = req.query;
    return listDocumentNumbers({
      customerId:            csvInt(q.customerId),
      customerName:          q.customerName          || undefined,
      salesRepId:            csvInt(q.salesRepId),
      salesRepName:          q.salesRepName          || undefined,
      opsPartnerId:          csvInt(q.opsPartnerId),
      opsPartnerName:        q.opsPartnerName        || undefined,
      businessVerticalId:    csvInt(q.businessVerticalId),
      businessVerticalName:  q.businessVerticalName  || undefined,
      departmentId:          csvInt(q.departmentId),
      departmentName:        q.departmentName        || undefined,
      projectNameId:         csvInt(q.projectNameId),
      projectName:           q.projectName           || undefined,
      statuses:              csvStr(q.statuses),
      productDeveloperId:    csvInt(q.productDeveloperId),
      productDeveloperName:  q.productDeveloperName  || undefined,
      likelyToCloseId:       csvInt(q.likelyToCloseId),
      likelyToCloseName:     q.likelyToCloseName     || undefined,
      esStatusId:            csvInt(q.esStatusId),
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
    search?: string;   // general free-text search across visible columns
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
      search:                q.search                || undefined,
      estimateId:            q.estimateId            ? parseInt(q.estimateId)            : undefined,
      documentNumber:        csvStr(q.documentNumber),
      customerId:            csvInt(q.customerId),
      customerName:          q.customerName          || undefined,
      salesRepId:            csvInt(q.salesRepId),
      salesRepName:          q.salesRepName          || undefined,
      opsPartnerId:          csvInt(q.opsPartnerId),
      opsPartnerName:        q.opsPartnerName        || undefined,
      businessVerticalId:    csvInt(q.businessVerticalId),
      businessVerticalName:  q.businessVerticalName  || undefined,
      departmentId:          csvInt(q.departmentId),
      departmentName:        q.departmentName        || undefined,
      projectNameId:         csvInt(q.projectNameId),
      projectName:           q.projectName           || undefined,
      statuses:              csvStr(q.statuses),
      productDeveloperId:    csvInt(q.productDeveloperId),
      productDeveloperName:  q.productDeveloperName  || undefined,
      likelyToCloseId:       csvInt(q.likelyToCloseId),
      likelyToCloseName:     q.likelyToCloseName     || undefined,
      esStatusId:            csvInt(q.esStatusId),
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

  // PATCH /api/v1/estimates/pipeline — bulk-update inline grid header fields on many
  // estimates in one request. Body: { items: [{ id, ...editedCells }] }. Only the narrow
  // set in PipelineFieldsSchema is accepted; everything else is stripped. Registered
  // before /:id so the static path wins.
  app.patch<{ Body: unknown }>('/pipeline', async (req) => {
    const body = req.body as { items?: unknown[] };
    const rawItems = Array.isArray(body?.items) ? body.items : [];
    const items = rawItems.map(it => stripEmpty(normalizeBody(it)));
    const parsed = PipelineBulkSchema.parse({ items });
    return updateEstimatesPipelineFields(parsed.items);
  });

  // PATCH /api/v1/estimates/:id — accepts JSON or multipart/form-data
  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req) => {
    const raw = req.headers['content-type']?.startsWith('multipart/form-data')
      ? await parseMultipartEstimate(req)
      : req.body as Record<string, unknown>;
    const { lineItems, freightGroups, ...headerData } = UpdateEstimateSchema.parse(stripEmpty(normalizeBody(raw)));
    return updateEstimateWithItems(parseInt(req.params.id), headerData, lineItems, freightGroups);
  });

  // DELETE /api/v1/estimates/:id — soft-delete (sets is_active=false)
  app.delete<{ Params: { id: string } }>('/:id', async (req) =>
    deactivateEstimate(parseInt(req.params.id)),
  );

  // DELETE /api/v1/estimates/:id/permanent — hard delete: permanently removes
  // the estimate and, via FK cascade, all its line items, freight groups and
  // quotes from the database.
  app.delete<{ Params: { id: string } }>('/:id/permanent', async (req) =>
    deleteEstimate(parseInt(req.params.id)),
  );
}
