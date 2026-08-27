import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uploadToR2, uploadCreativeRequestFile, materializeAttachment } from '../../services/r2.service.js';
import { AppError } from '../../utils/errors.js';
import {
  CREATIVE_REQUEST_TOGGLES,
  resolveToggle,
  addAttachmentsToRequest,
} from '../../services/creativeRequest.service.js';

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
  getNeedsAttentionCount,
  listNeedsAttention,
  getClosingThisWeekCount,
  listClosingThisWeek,
  getOpenEstimatesCount,
  listOpenEstimates,
  getOpenPipelineValue,
  listOpenPipelineValue,
} from '../../services/estimate.service.js';
import { createEstimateAndConvertToOtb } from '../../services/otbConvert.service.js';
import { previewNsPayload } from '../../services/netsuiteSync.service.js';

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

// ── Creative Requests ────────────────────────────────────────────────────────
// Four independent toggles. `null` means the toggle is OFF and its form data — stray or
// otherwise — is ignored entirely. Kept permissive here on purpose: per-field validation
// happens inside saveCreativeRequests so that ONE malformed toggle is reported as a failed
// toggle in the response rather than 400-ing the whole estimate save.
const CreativeRequestFormSchema = z.record(z.unknown());
const CreativeRequestsSchema = z.object({
  deckProduct:    CreativeRequestFormSchema.nullish(),
  setupProduct:   CreativeRequestFormSchema.nullish(),
  deckPackaging:  CreativeRequestFormSchema.nullish(),
  setupPackaging: CreativeRequestFormSchema.nullish(),
  // Accepted aliases — the client spec uses "artSetup*" for the Setup toggles.
  artSetupProduct:   CreativeRequestFormSchema.nullish(),
  artSetupPackaging: CreativeRequestFormSchema.nullish(),
}).partial();

// ── Header + line items + freight groups ─────────────────────────────────────
const CreateEstimateSchema = EstimateHeaderSchema.extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
  freightGroups: z.array(FreightGroupSchema).max(50).optional(),
  creativeRequests: CreativeRequestsSchema.nullish(),
  submittedByUserId: z.number().int().positive().optional(),
});
const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
  freightGroups: z.array(FreightGroupSchema).max(50).optional(),
  creativeRequests: CreativeRequestsSchema.nullish(),
  submittedByUserId: z.number().int().positive().optional(),
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
//           file (File, optional, repeatable) = estimate-level attachments, uploaded to R2
//           crFile:<toggle> (File, optional, repeatable) = creative-request attachments,
//                 e.g. crFile:deckProduct — routed to that toggle's attachments array
//
// `estimateId` is only known on PATCH; on POST it is null and creative-request files are
// keyed without an estimate segment in R2 — creative-requests/{toggle}/...
const CR_FILE_PREFIX = 'crFile:';

async function parseMultipartEstimate(
  req: FastifyRequest,
  estimateId: number | null = null,
): Promise<Record<string, unknown>> {
  const parts = req.parts();
  let raw: Record<string, unknown> = {};
  const uploaded: Array<{ name: string; url: string; size: number; type: string }> = [];
  // Creative-request files are buffered by toggle rather than written straight into `raw`:
  // req.parts() is a stream and the `data` part may arrive AFTER the files, so `raw` is not
  // yet populated inside this loop. Same reason `uploaded` exists.
  const crFiles: Record<string, Array<{ name: string; url: string; size: number; type: string }>> = {};
  let lineItemImage: { name: string; url: string; size: number; type: string } | null = null;
  let lineItemImageId: number | null = null;

  for await (const part of parts) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      // Empty parts are skipped for the generic fields — an unfilled form row is normal —
      // but NOT for crFile:*, which is handled explicitly below.
      if (buf.length === 0 && !part.fieldname.startsWith(CR_FILE_PREFIX)) continue;
      if (part.fieldname === 'lineItemImage') {
        lineItemImage = await uploadToR2(buf, part.filename ?? 'file', part.mimetype);
      } else if (part.fieldname.startsWith(CR_FILE_PREFIX)) {
        // An EMPTY crFile part is an ERROR, not something to skip. The generic `file` field
        // above tolerates empty parts because an unfilled form row is normal there, but
        // naming a specific toggle states intent: the caller believes they are sending a
        // file. Postman sends an empty part when its stored path has gone stale (the file was
        // moved or deleted — it shows a warning icon on the row), and skipping that silently
        // returned 200 with action "inserted" while the attachment quietly disappeared. That
        // is the invisible data loss this route guards against everywhere else.
        //
        // Thrown immediately rather than collected: parts already seen are uploaded, so
        // failing on the first empty one leaves the fewest orphaned objects in R2.
        if (buf.length === 0) {
          throw new AppError(
            `Field "${part.fieldname}" was sent with no file content. If you are using Postman, the file reference has gone stale — click "Select Files" and pick the file again.`,
            400, 'EMPTY_FILE',
          );
        }
        const toggleName = part.fieldname.slice(CR_FILE_PREFIX.length);
        // Validated here, before the upload, so a typo'd toggle fails loudly instead of
        // leaving an orphaned object in R2 and silently dropping the file.
        const def = resolveToggle(toggleName);
        if (!def) {
          throw new AppError(
            `Unknown creative request toggle "${toggleName}" in field "${part.fieldname}"`,
            400, 'UNKNOWN_TOGGLE',
          );
        }
        (crFiles[toggleName] ??= []).push(
          await uploadCreativeRequestFile(buf, part.filename ?? 'file', part.mimetype, estimateId, def.key),
        );
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

  // Merge creative-request files into the toggle objects now that `data` has been parsed.
  for (const [toggleName, files] of Object.entries(crFiles)) {
    const def = resolveToggle(toggleName)!;   // already validated above
    const cr = (raw.creativeRequests ??= {}) as Record<string, unknown>;

    // Write into the spelling the client actually used in `data`, falling back to the
    // canonical key. Writing to a second spelling would create two entries for one toggle,
    // and saveCreativeRequests() reads the canonical key first — so the form fields sent
    // under an alias would be ignored and the request saved with attachments but no data.
    const key = [def.key, ...(CREATIVE_REQUEST_TOGGLES.find(t => t.key === def.key)?.aliases ?? [])]
      .find(k => cr[k] !== undefined && cr[k] !== null) ?? def.key;

    const form = (cr[key] ??= {}) as Record<string, unknown>;
    const existing = Array.isArray(form.attachments) ? (form.attachments as unknown[]) : [];
    form.attachments = [...existing, ...files];
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

// ── Inline attachment materialisation ────────────────────────────────────────

/**
 * Field names that carry an attachment list.
 *
 * `attachWrike` is the legacy RESTlet spelling; `attachSetup` was the setup-toggle variant.
 * Both are accepted on either toggle type, so payloads written against either name keep
 * working — note the OUTBOUND payload now emits `attachWrike` for both types.
 *
 * All spellings are concatenated into one list. Since deduplication was removed, listing the
 * same file under two different keys stores it TWICE — send each file under one key only.
 */
const ATTACHMENT_LIST_KEYS = [
  'attachments', 'attachWrike', 'attach_wrike', 'attachmentsWrike', 'attachSetup', 'attach_setup',
];

/**
 * Upload any inline (base64 data: URI) attachments to R2 and rewrite each toggle's list to
 * plain {name, url, size, type} metadata, which is what the service layer stores.
 *
 * Runs in the ROUTE, after Zod validation and BEFORE the service opens its transaction, for
 * two reasons:
 *   - a payload that fails SCHEMA validation never uploads anything
 *   - the R2 round-trip does not happen while a database transaction is held open
 *
 * ORPHANS: per-toggle field validation (requestor, due date, item budget) happens later,
 * inside saveOneToggle, because it needs master-list lookups. A toggle that uploads
 * successfully and then fails validation — or that is skipped because the request already
 * exists — leaves its R2 object with no row pointing at it. That is the deliberate trade for
 * not holding a transaction open across a network call. If orphans need reclaiming, do it
 * with an R2 lifecycle rule on the creative-requests/ prefix or a reconciliation sweep
 * comparing keys against storage_uri; do not move the upload inside the transaction.
 *
 * Mutates `creativeRequests` in place. Entries that already carry a `url` are passed through
 * without a second upload, so the multipart path and POST /upload/file both still work.
 */
async function materializeCreativeRequestAttachments(
  creativeRequests: Record<string, unknown> | null | undefined,
  estimateId: number | null,
): Promise<void> {
  if (!creativeRequests || typeof creativeRequests !== 'object') return;

  for (const [key, form] of Object.entries(creativeRequests)) {
    if (!form || typeof form !== 'object' || Array.isArray(form)) continue;
    // An unknown key is left alone — saveCreativeRequests ignores it too, so uploading its
    // files would put objects in R2 that no row will ever reference.
    const def = resolveToggle(key);
    if (!def) continue;

    const f = form as Record<string, unknown>;

    // Collect every spelling into one list. A single object rather than an array is
    // tolerated, because a caller sending exactly one file often omits the brackets.
    const collected: unknown[] = [];
    for (const name of ATTACHMENT_LIST_KEYS) {
      const v = f[name];
      if (Array.isArray(v)) collected.push(...v);
      else if (v && typeof v === 'object') collected.push(v);
    }
    if (collected.length === 0) continue;

    const materialized: unknown[] = [];
    for (const entry of collected) {
      materialized.push(await materializeAttachment(entry, estimateId, def.key));
    }

    // Normalise onto `attachments` and drop the aliases, so the service reads one list and
    // cannot double-count a file that arrived under two names.
    f.attachments = materialized;
    for (const name of ATTACHMENT_LIST_KEYS) {
      if (name !== 'attachments') delete f[name];
    }
  }
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

// The "ME" filter chip — defaults to true (on) whenever the param is omitted,
// so a caller that doesn't know about it yet keeps today's mine-scoped
// behavior. Only an explicit "false" clears it.
const parseMe = (v?: string): boolean => v !== 'false';

// ── Routes ──────────────────────────────────────────────────────────────────

export default async function estimateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // GET /api/v1/estimates — paginated list
  app.get<{
    Querystring: { page?: string; limit?: string; search?: string; status?: string; customerId?: string; me?: string };
  }>('/', async (req) =>
    listEstimates({
      page: parseInt(req.query.page ?? '1'),
      limit: parseInt(req.query.limit ?? '20'),
      search: req.query.search,
      status: req.query.status,
      customerId: req.query.customerId ? parseInt(req.query.customerId) : undefined,
      me: parseMe(req.query.me),
      viewerUserId: req.user.id,
      viewerNetsuiteInternalId: req.user.netsuiteInternalId,
    }),
  );

  // POST /api/v1/estimates — accepts JSON or multipart/form-data (data field + file fields)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const raw = req.headers['content-type']?.startsWith('multipart/form-data')
      ? await parseMultipartEstimate(req)
      : req.body as Record<string, unknown>;
    const { lineItems, freightGroups, creativeRequests, submittedByUserId, ...headerData } =
      CreateEstimateSchema.parse(stripEmpty(normalizeBody(raw)));
    // Inline base64 attachments become R2 objects here. estimateId is null: the estimate has
    // no id until the transaction below commits, so the key omits the estimate segment.
    await materializeCreativeRequestAttachments(creativeRequests as Record<string, unknown> | undefined, null);
    // submittedByUserId is stored verbatim if the caller sends it. There is no user
    // management in the portal yet, so nothing is derived or looked up here.
    const result = await createEstimateWithItems(
      { ...headerData, createdBy: req.user.id },
      lineItems ?? [], freightGroups ?? [], creativeRequests, submittedByUserId ?? null,
    );
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
      viewerUserId:            req.user.id,
      viewerNetsuiteInternalId: req.user.netsuiteInternalId,
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
    me?: string;       // "ME" filter chip — defaults on; pass me=false once the user clears it
  };
  app.get<{ Querystring: SearchQuery }>('/search', async (req) => {
    const q = req.query;

    // When a specific estimate is selected (by id or exact document number),
    // return the full estimate with line items + freight groups instead of a summary list
    if (q.estimateId) {
      return getEstimate(parseInt(q.estimateId), { viewerUserId: req.user.id, viewerNetsuiteInternalId: req.user.netsuiteInternalId });
    }

    return searchEstimatesAdvanced({
      viewerUserId:            req.user.id,
      viewerNetsuiteInternalId: req.user.netsuiteInternalId,
      me:                    parseMe(q.me),
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

  // ── Pipeline dashboard tiles ────────────────────────────────────────────────
  // Backs the 4 stat tiles on the Pipeline screen. Each tile has a /count and a
  // /list endpoint, both scoped to the logged-in user via the same access
  // control as the rest of the estimates API.
  type TileListQuery = { page?: string; limit?: string };
  const tileViewer = (req: FastifyRequest) => ({
    viewerUserId: req.user.id,
    viewerNetsuiteInternalId: req.user.netsuiteInternalId,
  });
  const tileListOpts = (req: FastifyRequest<{ Querystring: TileListQuery }>) => ({
    ...tileViewer(req),
    page: parseInt(req.query.page ?? '1'),
    limit: Math.min(parseInt(req.query.limit ?? '20'), 100),
  });

  // GET /api/v1/estimates/needs-attention/count
  app.get('/needs-attention/count', async (req) => getNeedsAttentionCount(tileViewer(req)));
  // GET /api/v1/estimates/needs-attention/list
  app.get<{ Querystring: TileListQuery }>('/needs-attention/list', async (req) =>
    listNeedsAttention(tileListOpts(req)));

  // GET /api/v1/estimates/closing-this-week/count
  app.get('/closing-this-week/count', async (req) => getClosingThisWeekCount(tileViewer(req)));
  // GET /api/v1/estimates/closing-this-week/list
  app.get<{ Querystring: TileListQuery }>('/closing-this-week/list', async (req) =>
    listClosingThisWeek(tileListOpts(req)));

  // GET /api/v1/estimates/open/count
  app.get('/open/count', async (req) => getOpenEstimatesCount(tileViewer(req)));
  // GET /api/v1/estimates/open/list
  app.get<{ Querystring: TileListQuery }>('/open/list', async (req) =>
    listOpenEstimates(tileListOpts(req)));

  // GET /api/v1/estimates/open-pipeline-value/count
  app.get('/open-pipeline-value/count', async (req) => getOpenPipelineValue(tileViewer(req)));
  // GET /api/v1/estimates/open-pipeline-value/list
  app.get<{ Querystring: TileListQuery }>('/open-pipeline-value/list', async (req) =>
    listOpenPipelineValue(tileListOpts(req)));

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

  // GET /api/v1/estimates/:id/netsuite-payload — inspect the NetSuite payload WITHOUT sending
  //
  // Read-only dry run. NS_SUITELET_URL points at a live restlet, so before this endpoint the
  // only way to see what NetSuite receives was to actually post it and mutate a real record.
  // Nothing is logged with the body either, so this is the way to verify creativeRequests[]
  // and its attachWrike / attachSetup arrays.
  //
  // ?mode=create|update|convert (default: update) — only affects a few header fields.
  //
  // Registered BEFORE '/:id' so "netsuite-payload" is not swallowed as an estimate id.
  app.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
    '/:id/netsuite-payload',
    async (req) => {
      const mode = req.query.mode ?? 'update';
      if (mode !== 'create' && mode !== 'update' && mode !== 'convert') {
        throw new AppError('mode must be one of: create, update, convert', 400, 'INVALID_MODE');
      }
      return previewNsPayload(parseInt(req.params.id), mode);
    },
  );

  // GET /api/v1/estimates/:id — full estimate with line items
  app.get<{ Params: { id: string } }>('/:id', async (req) =>
    getEstimate(parseInt(req.params.id), { viewerUserId: req.user.id, viewerNetsuiteInternalId: req.user.netsuiteInternalId }),
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
      ? await parseMultipartEstimate(req, parseInt(req.params.id))
      : req.body as Record<string, unknown>;
    const { lineItems, freightGroups, creativeRequests, submittedByUserId, ...headerData } =
      UpdateEstimateSchema.parse(stripEmpty(normalizeBody(raw)));
    await materializeCreativeRequestAttachments(
      creativeRequests as Record<string, unknown> | undefined, parseInt(req.params.id),
    );
    return updateEstimateWithItems(
      parseInt(req.params.id), headerData, lineItems, freightGroups, creativeRequests, submittedByUserId ?? null,
    );
  });

  // POST /api/v1/estimates/:id/creative-requests/:toggle/attachments
  //
  // Add files to a creative request that ALREADY EXISTS. This endpoint exists because the
  // estimate save is insert-only for creative requests: saveOneToggle() returns
  // skipped_exists before it reaches the attachment step, so a file sent with a later
  // PATCH would be silently discarded. Adding files after creation has to come through here.
  //
  // Accepts either shape:
  //   multipart/form-data — one or more file parts, any field name, uploaded to R2 here
  //   application/json    — { "attachments": [{ name, url, size }] } for callers that
  //                         already uploaded via POST /api/v1/upload/file
  app.post<{ Params: { id: string; toggle: string }; Body: unknown }>(
    '/:id/creative-requests/:toggle/attachments',
    async (req, reply) => {
      const estimateId = parseInt(req.params.id);
      if (!Number.isInteger(estimateId) || estimateId < 1) {
        throw new AppError('Invalid estimate id', 400, 'INVALID_ID');
      }

      // Resolved before any upload so an unknown toggle costs nothing.
      const def = resolveToggle(req.params.toggle);
      if (!def) {
        throw new AppError(
          `Unknown creative request toggle "${req.params.toggle}". Expected one of: ${CREATIVE_REQUEST_TOGGLES.map(t => t.key).join(', ')}`,
          400, 'UNKNOWN_TOGGLE',
        );
      }

      let attachments: unknown[];
      if (req.headers['content-type']?.startsWith('multipart/form-data')) {
        const collected: unknown[] = [];
        for await (const part of req.parts()) {
          if (part.type !== 'file') continue;
          const buf = await part.toBuffer();
          if (buf.length === 0) continue;
          collected.push(
            await uploadCreativeRequestFile(buf, part.filename ?? 'file', part.mimetype, estimateId, def.key),
          );
        }
        attachments = collected;
      } else {
        // JSON body. Accepts every attachment-list spelling, and each entry may be either
        // already-uploaded metadata or an inline base64 data: URI.
        const body = (req.body ?? {}) as Record<string, unknown>;
        const collected: unknown[] = [];
        for (const name of ATTACHMENT_LIST_KEYS) {
          const v = body[name];
          if (Array.isArray(v)) collected.push(...v);
          else if (v && typeof v === 'object') collected.push(v);
        }
        attachments = [];
        for (const entry of collected) {
          attachments.push(await materializeAttachment(entry, estimateId, def.key));
        }
      }

      if (attachments.length === 0) {
        throw new AppError('No files provided', 400, 'FILE_REQUIRED');
      }

      const result = await addAttachmentsToRequest(estimateId, def.key, attachments);
      return reply.status(201).send(result);
    },
  );

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
