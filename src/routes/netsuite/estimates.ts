/**
 * ESTIMATE APIs
 * Called by NetSuite SuiteScript when an estimate is created or changed.
 *
 *  POST   /api/v1/netsuite/estimates                → create estimate (without line items)
 *  POST   /api/v1/netsuite/estimates/with-items     → create estimate WITH line items (atomic)
 *  POST   /api/v1/netsuite/estimates/sync           → UPSERT estimate + line items (with components)
 *  PUT    /api/v1/netsuite/estimates/:nsId          → update estimate
 *  DELETE /api/v1/netsuite/estimates/:nsId          → deactivate estimate
 *  GET    /api/v1/netsuite/estimates                → list estimates
 *  GET    /api/v1/netsuite/estimates/:nsId          → get single estimate + line items
 *
 * IMPORTANT ORDER: Push customers/departments/employees BEFORE estimates.
 * Estimates reference those records by NS internalId.
 */

import { FastifyInstance } from 'fastify';
import { eq, desc, asc, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import {
  estimates, estimateLineItems,
  customers, contacts, currencies, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  accountManagers, productDevelopers, hkPartners, opsPartners, compliancePartners,
  subsidiaries, estimateStatuses, esStatus, closedLostReasons, clientPursuitAlternatives,
  clientIncoterms, clientShippingMethods, addresses,
  csItems, vendors, factories, productClasses, productClassesEu,
  sustainabilityOptions, vendorIncoterms, vendorAddresses, componentKitItems,
  projectNames, estimateFreightGroups, drayage,
} from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

// ─── Helper: resolve portal FK from NS internalId ─────────────────
// NS sends its own internalIds. We look them up to get our portal ids.

async function resolveNsId(table: any, nsId: string | undefined | null): Promise<number | null> {
  if (!nsId) return null;
  const db = getDb();
  const [row] = await db.select({ id: table.id }).from(table)
    .where(eq(table.netsuiteInternalId, nsId)).limit(1);
  return row?.id ?? null;
}

// ─── Validation ───────────────────────────────────────────────────

const CreateEstimateSchema = z.object({
  // Required
  netsuiteInternalId   : z.string().min(1),  // NS internalId of this estimate
  documentNumber       : z.string().max(100).optional().nullable(), // NS transaction id e.g. "EST-0042"
  projectName          : z.string().min(1).max(255),
  customerNsId         : z.string().min(1),  // NS internalId of the customer

  // Optional — send NS internalIds for each lookup field
  projectNameNsId      : z.string().optional().nullable(),  // NS internalId of project_names → estimates.project_name_id
  subsidiaryNsId       : z.string().optional().nullable(),
  customerContactNsId  : z.string().optional().nullable(),
  customerPo           : z.string().max(100).optional().nullable(),
  projectTypeNsId      : z.string().optional().nullable(),
  trandate             : z.string().optional().nullable(),  // NS transaction date "YYYY-MM-DD"
  expectedCloseDate    : z.string().optional().nullable(),  // "YYYY-MM-DD"
  promiseDate          : z.string().optional().nullable(),
  likelyToCloseNsId    : z.string().optional().nullable(),
  sellCurrencyNsId     : z.string().optional().nullable(),
  projectedTotalAmt    : z.string().optional().nullable(),
  estimatedQty         : z.number().int().optional().nullable(),
  adjustedPipelineAmountNS: z.string().optional().nullable(),  // NS currency field → estimates.adjusted_pipeline

  // Classification
  departmentNsId       : z.string().optional().nullable(),
  salesChannelNsId     : z.string().optional().nullable(),
  businessVerticalNsId : z.string().optional().nullable(),
  businessTypeNsId     : z.string().optional().nullable(),
  compliancePartnerNsId: z.string().optional().nullable(),
  acctManagerNsId      : z.string().optional().nullable(),
  // Product developers/managers — NS can send one id or many. Accept both.
  productDeveloperNsId : z.string().optional().nullable(),
  productDeveloperNsIds: z.array(z.string()).optional().nullable(),
  hkPartnerNsId        : z.string().optional().nullable(),
  opsPartner1NsId      : z.string().optional().nullable(),
  opsPartner2NsId      : z.string().optional().nullable(),
  deckRequest          : z.boolean().optional(),
  artSetupRequest      : z.boolean().optional(),
  pkgDeckRequest       : z.boolean().optional(),
  pkgArtSetupRequest   : z.boolean().optional(),

  // Shipping & billing
  clientIncotermsNsId  : z.string().optional().nullable(),
  clientShipMethodNsId : z.string().optional().nullable(),
  shippingAddressNsId  : z.string().optional().nullable(),
  billingAddressNsId   : z.string().optional().nullable(),
  shipTo               : z.string().optional().nullable(),  // Ship To free-text from NS
  billTo               : z.string().optional().nullable(),  // Bill To free-text from NS

  // Edit / Update fields (status, win/loss, close-lost)
  statusNsId                  : z.string().optional().nullable(),
  esStatusNsId                : z.string().optional().nullable(),  // NS internalId of es_status (2=Converted To Quote, 4=Partially Converted, …)
  closedLostReasonNsId        : z.string().optional().nullable(),
  clientPursuitAlternativeNsId: z.string().optional().nullable(),
  notesClosedLostReason       : z.string().optional().nullable(),
  projectHoldDate             : z.string().optional().nullable(),

  // Additional
  sampleOnlyOrder      : z.boolean().optional(),
  reOrder              : z.boolean().optional(),
  bibleLink            : z.string().optional().nullable(),
  memo                 : z.string().optional().nullable(),

  // Twelve Pays — YES/NO flags (custbody_twelve_pays_import_frt / custbody_twelve_pays_ship_to_cust)
  twelvePaysImportFrt  : z.enum(['YES', 'NO']).optional().nullable(),
  twelvePaysShipToCust : z.enum(['YES', 'NO']).optional().nullable(),
});

// Update allows all the same fields but nothing is required
const UpdateEstimateSchema = CreateEstimateSchema
  .omit({ netsuiteInternalId: true })
  .partial();

// Line Item Schema (for combined endpoint)
const LineItemSchema = z.object({
  netsuiteInternalId  : z.string().optional().nullable(),
  itemTypeId          : z.number().int().optional().nullable(),
  shortDescription    : z.string().max(500).optional().nullable(),
  vendorId            : z.number().int().optional().nullable(),
  quantity            : z.string().optional().nullable(),
  sellPricePerUnit    : z.string().optional().nullable(),
  description         : z.string().optional().nullable(),
  factoryId           : z.number().int().optional().nullable(),
  vendorCurrencyId    : z.number().int().optional().nullable(),
  factoryCostPerUnit  : z.string().optional().nullable(),
  packingCostPerUnit  : z.string().optional().nullable(),
  sampleFees          : z.string().optional().nullable(),
  otherPerUnit        : z.string().optional().nullable(),
  freightPerUnit      : z.string().optional().nullable(),
  dutyPct             : z.string().optional().nullable(),
  tariffPct           : z.string().optional().nullable(),
  tariffMuPct         : z.string().optional().nullable(),
  otherCostPct        : z.string().optional().nullable(),
  paddingPct          : z.string().optional().nullable(),
  productClassId      : z.number().int().optional().nullable(),
  sustainabilityId    : z.number().int().optional().nullable(),
  htsCode             : z.string().max(20).optional().nullable(),
  countryOfOrigin     : z.string().max(100).optional().nullable(),
  countryOfDest       : z.enum(['US','EU']).optional(),
  unitsPerCarton      : z.number().int().optional().nullable(),
  dimLCm              : z.string().optional().nullable(),
  dimWCm              : z.string().optional().nullable(),
  dimHCm              : z.string().optional().nullable(),
  weightKgPerCarton   : z.string().optional().nullable(),
  shippingGroupId     : z.string().max(255).optional().nullable(),
  exFactoryDate       : z.string().optional().nullable(),
  vendorIncotermsId   : z.number().int().optional().nullable(),
  shipToVendorId      : z.number().int().optional().nullable(),
  notes               : z.string().optional().nullable(),
  exclude             : z.boolean().optional(),
  pickupExwFob        : z.string().optional().nullable(),
  oceanDdp            : z.string().optional().nullable(),
  airDdp              : z.string().optional().nullable(),
  trueTariff          : z.string().max(255).optional().nullable(),
});

// Combined Schema: Create estimate WITH line items in single transaction
const CreateEstimateWithItemsSchema = z.object({
  estimate  : CreateEstimateSchema,
  lineItems : z.array(LineItemSchema).max(400).optional(), // up to 400 line items
});

// ─── SYNC schemas (inbound from NetSuite, NS internal IDs everywhere) ─────────
// Used by POST /sync — upsert estimate + line items (with optional components).
// Every reference field is an NS internalId string; we reverse-map to portal ids.

const SyncLineItemSchema = z.object({
  netsuiteInternalId   : z.string().optional().nullable(), // NS line id — used to match existing line
  itemTypeNsId         : z.string().optional().nullable(), // → cs_items
  componentKitItemNsId : z.string().optional().nullable(), // → component_kit_items (for components)
  shortDescription     : z.string().max(500).optional().nullable(),
  description          : z.string().optional().nullable(),
  vendorNsId           : z.string().optional().nullable(), // → vendors
  quantity             : z.string().optional().nullable(),
  sellPricePerUnit     : z.string().optional().nullable(),
  skuMarginPct         : z.string().optional().nullable(),
  salesAmount          : z.string().optional().nullable(),
  pickupExwFob         : z.string().optional().nullable(),
  oceanDdp             : z.string().optional().nullable(),
  airDdp               : z.string().optional().nullable(),
  exclude              : z.boolean().optional(),
  factoryNsId          : z.string().optional().nullable(), // → factories
  vendorCurrencyNsId   : z.string().optional().nullable(), // → currencies
  factoryCostPerUnit   : z.string().optional().nullable(),
  packingCostPerUnit   : z.string().optional().nullable(),
  sampleFees           : z.string().optional().nullable(),
  otherPerUnit         : z.string().optional().nullable(),
  freightPerUnit       : z.string().optional().nullable(),
  dutyPct              : z.string().optional().nullable(),
  tariffPct            : z.string().optional().nullable(),
  tariffMuPct          : z.string().optional().nullable(),
  otherCostPct         : z.string().optional().nullable(),
  paddingPct           : z.string().optional().nullable(),
  usdFactoryCost       : z.string().optional().nullable(),
  landedCostPerUnit    : z.string().optional().nullable(),
  extendedLandedCost   : z.string().optional().nullable(),
  productClassNsId     : z.string().optional().nullable(), // → product_classes
  productClassEuNsId   : z.string().optional().nullable(), // → product_classes_eu
  sustainabilityNsId   : z.string().optional().nullable(), // → sustainability_options
  htsCode              : z.string().max(20).optional().nullable(),
  countryOfOrigin      : z.string().max(100).optional().nullable(),
  countryOfDest        : z.enum(['US','EU']).optional(),
  unitsPerCarton       : z.number().int().optional().nullable(),
  dimLCm               : z.string().optional().nullable(),
  dimWCm               : z.string().optional().nullable(),
  dimHCm               : z.string().optional().nullable(),
  weightKgPerCarton    : z.string().optional().nullable(),
  cbmPerCarton         : z.string().optional().nullable(),
  totalCartons         : z.number().int().optional().nullable(),
  totalCbm             : z.string().optional().nullable(),
  chargeableWeightKg   : z.string().optional().nullable(),
  shippingGroupId      : z.string().max(255).optional().nullable(),
  exFactoryDate        : z.string().optional().nullable(),
  vendorIncotermsNsId  : z.string().optional().nullable(), // → vendor_incoterms
  shipToVendorNsId     : z.string().optional().nullable(), // → vendors
  shipToVendorAddrNsId : z.string().optional().nullable(), // → vendor_addresses
  notes                : z.string().optional().nullable(),
  trueTariff           : z.string().max(255).optional().nullable(),

  // Extended line fields
  paddingAmount        : z.string().optional().nullable(),   // numeric string
  dutyMarkupAmount     : z.string().optional().nullable(),   // numeric string
  shippingInstruction  : z.string().optional().nullable(),
  additionalFeeInfo    : z.string().optional().nullable(),
  vendorSku            : z.string().max(255).optional().nullable(),
  lineComponents       : z.string().optional().nullable(),
  // NS sends this as a string. Coerce to int; any empty/blank/non-numeric
  // value becomes null so a bad id never NaNs or rejects the whole estimate.
  previousLineId       : z.preprocess(
    (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    },
    z.number().int().nullable(),
  ).optional(),
  excludeFromPrint     : z.boolean().optional(),
  converted            : z.boolean().optional(),

  selected             : z.boolean().optional(),
});

// Parent line item carries an optional nested components array
const SyncLineItemWithComponentsSchema = SyncLineItemSchema.extend({
  components: z.array(SyncLineItemSchema).max(50).optional(),
});

// Explicit freight group from NetSuite. itemNsIds reference member lines by their
// NS internal id (resolved to portal line ids on persist). freightModeSelected is a
// short code ("FCL"/"LCL"/"AIR"/…) or canonical mode; freightTotal/PerUnit/Pol/Pod
// are the single freight values for the group's selected mode.
const SyncFreightGroupSchema = z.object({
  groupName:           z.string().max(255).optional().nullable(),
  freightModeSelected: z.string().max(20).optional().nullable(),
  drayageNsId:         z.string().optional().nullable(),
  itemNsIds:           z.array(z.string()).optional(),
  numItems:            z.number().int().nonnegative().optional().nullable(),
  totalCartons:        z.number().int().nonnegative().optional().nullable(),
  totalCbm:            z.string().optional().nullable(),
  totalWeight:         z.string().optional().nullable(),
  freightTotal:        z.string().optional().nullable(),
  freightPerUnit:      z.string().optional().nullable(),
  freightPol:          z.string().max(255).optional().nullable(),
  freightPod:          z.string().max(255).optional().nullable(),
});

const SyncEstimateSchema = z.object({
  estimate  : CreateEstimateSchema,
  lineItems : z.array(SyncLineItemWithComponentsSchema).max(400).optional(),
  freightGroups: z.array(SyncFreightGroupSchema).max(50).optional(),
});

// ─── Route handlers ───────────────────────────────────────────────

export default async function estimateNsRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/estimates ─────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>('/', async (req) => {
    const db = getDb();
    const page   = parseInt(req.query.page  ?? '1');
    const limit  = parseInt(req.query.limit ?? '20');
    const offset = (page - 1) * limit;
    const rows = await db
      .select({
        id                 : estimates.id,
        netsuiteInternalId : estimates.netsuiteInternalId,
        projectName        : estimates.projectName,
        status             : estimates.status,
        customerPo         : estimates.customerPo,
        projectedTotalAmt  : estimates.projectedTotalAmt,
        expectedCloseDate  : estimates.expectedCloseDate,
        createdAt          : estimates.createdAt,
      })
      .from(estimates)
      .where(eq(estimates.isActive, true))
      .orderBy(desc(estimates.updatedAt))
      .limit(limit).offset(offset);
    return { data: rows, page, limit };
  });

  // ── GET /api/v1/netsuite/estimates/:nsId ───────────────────────
  // Returns the estimate header + all its line items
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [est] = await db.select().from(estimates)
      .where(eq(estimates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!est) throw new NotFoundError('Estimate', req.params.nsId);
    const lineItems = await db.select().from(estimateLineItems)
      .where(eq(estimateLineItems.estimateId, est.id))
      .orderBy(asc(estimateLineItems.lineNumber));
    return { ...est, lineItems };
  });

  // ── POST /api/v1/netsuite/estimates ────────────────────────────
  // Create a new estimate.
  //
  // Example body:
  // {
  //   "netsuiteInternalId": "EST-001",
  //   "projectName": "Q3 Promo — Acme",
  //   "customerNsId": "1234",
  //   "acctManagerNsId": "5678",
  //   "departmentNsId": "91",
  //   "sellCurrencyNsId": "3",
  //   "expectedCloseDate": "2025-09-30",
  //   "projectedTotalAmt": "50000.00",
  //   "memo": "Priority order"
  // }
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    // Log the RAW inbound body (before Zod strips unknown keys) so we can see the
    // exact field names NetSuite sends and confirm every value is captured.
    logger.info({ rawBody: req.body }, '→ NetSuite estimate POST / raw payload');
    const body = CreateEstimateSchema.parse(req.body);
    const db = getDb();

    // Idempotency — if this NS estimate already saved, update instead
    const [existing] = await db.select({ id: estimates.id }).from(estimates)
      .where(eq(estimates.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const updated = await applyEstimateUpdate(existing.id, body);
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    // Resolve customer — required
    const customerId = await resolveNsId(customers, body.customerNsId);
    if (!customerId) {
      throw new ValidationError(
        `Customer with NS internalId '${body.customerNsId}' not found. ` +
        `Push the customer first via POST /api/v1/netsuite/customers`,
      );
    }

    // Resolve all other FK fields
    const values = await buildEstimateValues(body, customerId);
    const [created] = await db.insert(estimates).values(values).returning();
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── POST /api/v1/netsuite/estimates/with-items ─────────────────
  // Create estimate WITH line items in a SINGLE ATOMIC TRANSACTION
  // Either both succeed or both are rolled back.
  //
  // Example body:
  // {
  //   "estimate": {
  //     "netsuiteInternalId": "EST-001",
  //     "projectName": "Q3 Promo",
  //     "customerNsId": "1234",
  //     "departmentNsId": "91",
  //     ...
  //   },
  //   "lineItems": [
  //     { "itemTypeId": 1, "quantity": "100", "sellPricePerUnit": "10.50", ... },
  //     { "itemTypeId": 2, "quantity": "200", "sellPricePerUnit": "8.25", ... },
  //     ... up to 400 items
  //   ]
  // }
  app.post<{ Body: unknown }>('/with-items', async (req, reply) => {
    logger.info({ rawBody: req.body }, '→ NetSuite estimate /with-items raw payload');
    const { estimate: estimateData, lineItems } = CreateEstimateWithItemsSchema.parse(req.body);
    const db = getDb();
    const startTime = Date.now();

    logger.info({ 
      netsuiteId: estimateData.netsuiteInternalId, 
      lineItemCount: lineItems?.length || 0 
    }, 'Creating estimate with line items in transaction');

    try {
      // Use transaction to ensure atomicity
      const result = await db.transaction(async (tx) => {
        // 1. Check if estimate already exists (idempotency)
        const [existing] = await tx.select({ id: estimates.id }).from(estimates)
          .where(eq(estimates.netsuiteInternalId, estimateData.netsuiteInternalId)).limit(1);
        
        if (existing) {
          throw new ValidationError(
            `Estimate with NetSuite ID '${estimateData.netsuiteInternalId}' already exists. ` +
            `Use PUT to update or delete first.`
          );
        }

        // 2. Resolve customer (required)
        const customerId = await resolveNsId(customers, estimateData.customerNsId);
        if (!customerId) {
          throw new ValidationError(
            `Customer with NS internalId '${estimateData.customerNsId}' not found. ` +
            `Push the customer first via POST /api/v1/netsuite/customers`
          );
        }

        // 3. Build and insert estimate
        const estimateValues = await buildEstimateValues(estimateData, customerId);
        const [createdEstimate] = await tx.insert(estimates).values(estimateValues).returning();

        logger.debug({ estimateId: createdEstimate.id }, 'Estimate created, inserting line items');

        // 4. Insert line items if provided
        let insertedLineItems = 0;
        if (lineItems && lineItems.length > 0) {
          const CHUNK = 100;
          let lineNumber = 1;
          
          for (let i = 0; i < lineItems.length; i += CHUNK) {
            const chunk = lineItems.slice(i, i + CHUNK).map((item, offset) => ({
              ...item,
              estimateId : createdEstimate.id,
              lineNumber : lineNumber + offset,
            }));
            lineNumber += chunk.length;
            
            await tx.insert(estimateLineItems).values(chunk as any);
            insertedLineItems += chunk.length;
            
            logger.debug({ 
              estimateId: createdEstimate.id, 
              inserted: insertedLineItems, 
              total: lineItems.length 
            }, `Inserted chunk (${insertedLineItems}/${lineItems.length})`);
          }
        }

        return { estimate: createdEstimate, lineItemsInserted: insertedLineItems };
      });

      const duration = Date.now() - startTime;
      logger.info({ 
        estimateId: result.estimate.id,
        netsuiteId: result.estimate.netsuiteInternalId,
        lineItemsInserted: result.lineItemsInserted,
        durationMs: duration 
      }, 'Estimate with line items created successfully');

      return reply.status(201).send({ 
        ...result.estimate, 
        _action: 'created',
        _lineItemsInserted: result.lineItemsInserted
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ 
        netsuiteId: estimateData.netsuiteInternalId,
        lineItemCount: lineItems?.length || 0,
        durationMs: duration,
        error 
      }, 'Failed to create estimate with line items - transaction rolled back');
      throw error;
    }
  });

  // ── POST /api/v1/netsuite/estimates/sync ───────────────────────
  // Full upsert of an estimate + line items (with optional components).
  // Called by NetSuite after an estimate is created/edited in NS.
  //
  // - Estimate is matched by netsuiteInternalId → updated if found, else created.
  // - documentNumber from NS is stored on the estimate.
  // - Each line item is matched by its NS line internal id → updated, else inserted.
  //   Lines that exist in the DB but are NOT in the payload are deleted.
  // - Components are nested under their parent line via `components: [...]`.
  //
  // Example body:
  // {
  //   "estimate": {
  //     "netsuiteInternalId": "404146",
  //     "documentNumber": "EST-0042",
  //     "projectName": "Holiday Kit",
  //     "customerNsId": "1627",
  //     "departmentNsId": "51"
  //   },
  //   "lineItems": [
  //     {
  //       "netsuiteInternalId": "67001",
  //       "itemTypeNsId": "25",
  //       "shortDescription": "Tumbler Gift Set",
  //       "quantity": "3000",
  //       "components": [
  //         { "netsuiteInternalId": "67002", "componentKitItemNsId": "1", "shortDescription": "Tumbler Body" }
  //       ]
  //     },
  //     { "netsuiteInternalId": "67005", "itemTypeNsId": "4", "shortDescription": "Tote Bag" }
  //   ]
  // }
  app.post<{ Body: unknown }>('/sync', async (req, reply) => {
    // Log the RAW inbound body (before Zod strips unknown keys) so we can see the
    // exact field names NetSuite sends and confirm every value is captured.
    logger.info({ rawBody: req.body }, '→ NetSuite estimate /sync raw payload');
    const { estimate: estData, lineItems, freightGroups } = SyncEstimateSchema.parse(req.body);
    const db = getDb();
    const startTime = Date.now();

    logger.info({ netsuiteId: estData.netsuiteInternalId, lineItemCount: lineItems?.length ?? 0 },
      'Syncing estimate from NetSuite (upsert)');

    const result = await db.transaction(async (tx) => {
      // 1. Resolve customer (required)
      const customerId = await resolveNsId(customers, estData.customerNsId);
      if (!customerId) {
        throw new ValidationError(
          `Customer with NS internalId '${estData.customerNsId}' not found. Push the customer first.`,
        );
      }

      // 2. Upsert the estimate header by netsuiteInternalId
      const [existing] = await tx.select({ id: estimates.id }).from(estimates)
        .where(eq(estimates.netsuiteInternalId, estData.netsuiteInternalId)).limit(1);

      let estimateId: number;
      let action: 'created' | 'updated';
      const values = await buildEstimateValues(estData, customerId);

      if (existing) {
        await tx.update(estimates).set({ ...values, updatedAt: new Date() } as any)
          .where(eq(estimates.id, existing.id));
        estimateId = existing.id;
        action = 'updated';
      } else {
        const [created] = await tx.insert(estimates).values(values as any).returning({ id: estimates.id });
        estimateId = created.id;
        action = 'created';
      }

      // 3. Upsert line items (parents first, then components)
      const lineResult = await upsertNsLineItems(tx, estimateId, lineItems ?? []);

      // 4. Persist the freight groups NetSuite sent (freightGroups[] array),
      //    stored ONLY in estimate_freight_groups; each member line is linked
      //    via freight_group_id.
      const freightGroupCount = await persistNsFreightGroups(
        tx, estimateId, freightGroups ?? [], lineResult.nsIdToDbId,
      );

      return { estimateId, action, ...lineResult, freightGroupCount };
    });

    logger.info({
      netsuiteId: estData.netsuiteInternalId,
      estimateId: result.estimateId,
      action    : result.action,
      parents   : result.parentCount,
      components : result.componentCount,
      deleted   : result.deletedCount,
      freightGroups: result.freightGroupCount,
      durationMs: Date.now() - startTime,
    }, 'Estimate synced from NetSuite');

    return reply.status(action200(result.action)).send({
      portalId          : result.estimateId,
      netsuiteInternalId: estData.netsuiteInternalId,
      documentNumber    : estData.documentNumber ?? null,
      _action           : result.action,
      lineItems         : { parents: result.parentCount, components: result.componentCount, deleted: result.deletedCount },
      freightGroups     : result.freightGroupCount,
    });
  });

  // ── PUT /api/v1/netsuite/estimates/:nsId ───────────────────────
  // Update an existing estimate. Only fields in the body are changed.
  //
  // Example: just update the memo and close date —
  //   PUT /api/v1/netsuite/estimates/EST-001
  //   Body: { "memo": "Updated notes", "expectedCloseDate": "2025-10-15" }
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateEstimateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: estimates.id }).from(estimates)
      .where(eq(estimates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Estimate', req.params.nsId);
    return applyEstimateUpdate(existing.id, body);
  });

  // ── DELETE /api/v1/netsuite/estimates/:nsId ────────────────────
  // Soft delete — sets isActive=false.
  // The estimate is hidden from the portal but data is kept.
  app.delete<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [existing] = await db.select({ id: estimates.id }).from(estimates)
      .where(eq(estimates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Estimate', req.params.nsId);
    await db.update(estimates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(estimates.id, existing.id));
    return { deleted: true, nsId: req.params.nsId, portalId: existing.id };
  });
}

// ─── Private helpers ──────────────────────────────────────────────

async function buildEstimateValues(body: z.infer<typeof CreateEstimateSchema>, customerId: number) {
  return {
    netsuiteInternalId   : body.netsuiteInternalId,
    documentNumber       : body.documentNumber,
    projectName          : body.projectName,
    projectNameId        : await resolveNsId(projectNames, body.projectNameNsId),
    customerId,
    subsidiaryId         : await resolveNsId(subsidiaries,       body.subsidiaryNsId),
    customerContactId    : await resolveNsId(contacts,           body.customerContactNsId),
    customerPo           : body.customerPo,
    projectTypeId        : await resolveNsId(projectTypes,       body.projectTypeNsId),
    trandate             : body.trandate,
    expectedCloseDate    : body.expectedCloseDate,
    promiseDate          : body.promiseDate,
    likelyToCloseId      : await resolveNsId(likelyToClose,      body.likelyToCloseNsId),
    sellCurrencyId       : await resolveNsId(currencies,         body.sellCurrencyNsId),
    projectedTotalAmt    : body.projectedTotalAmt,
    estimatedQty         : body.estimatedQty,
    adjustedPipeline     : numStrOrNull(body.adjustedPipelineAmountNS),
    departmentId         : await resolveNsId(departments,        body.departmentNsId),
    salesChannelId       : await resolveNsId(salesChannels,      body.salesChannelNsId),
    businessVerticalId   : await resolveNsId(businessVerticals,  body.businessVerticalNsId),
    businessTypeId       : await resolveNsId(businessTypes,      body.businessTypeNsId),
    compliancePartnerId  : await resolveNsId(compliancePartners, body.compliancePartnerNsId),
    acctManagerId        : await resolveNsId(accountManagers,    body.acctManagerNsId),
    productDeveloperIds  : await resolveProductDeveloperIds(body),
    hkPartnerId          : await resolveNsId(hkPartners,         body.hkPartnerNsId),
    opsPartner1Id        : await resolveNsId(opsPartners,        body.opsPartner1NsId),
    opsPartner2Id        : await resolveNsId(opsPartners,        body.opsPartner2NsId),
    deckRequest          : body.deckRequest        ?? false,
    artSetupRequest      : body.artSetupRequest    ?? false,
    pkgDeckRequest       : body.pkgDeckRequest     ?? false,
    pkgArtSetupRequest   : body.pkgArtSetupRequest ?? false,
    clientIncotermsId    : await resolveNsId(clientIncoterms,       body.clientIncotermsNsId),
    clientShipMethodId   : await resolveNsId(clientShippingMethods, body.clientShipMethodNsId),
    shippingAddressId    : await resolveNsId(addresses,          body.shippingAddressNsId),
    billingAddressId     : await resolveNsId(addresses,          body.billingAddressNsId),
    shipTo               : body.shipTo,
    billTo               : body.billTo,
    statusId                   : await resolveNsId(estimateStatuses,           body.statusNsId),
    esStatusId                 : await resolveNsId(esStatus,                    body.esStatusNsId),
    closedLostReasonId         : await resolveNsId(closedLostReasons,          body.closedLostReasonNsId),
    clientPursuitAlternativeId : await resolveNsId(clientPursuitAlternatives,  body.clientPursuitAlternativeNsId),
    notesClosedLostReason      : body.notesClosedLostReason,
    projectHoldDate            : body.projectHoldDate,
    sampleOnlyOrder      : body.sampleOnlyOrder ?? false,
    reOrder              : body.reOrder         ?? false,
    bibleLink            : body.bibleLink,
    memo                 : body.memo,
    twelvePaysImportFrt  : body.twelvePaysImportFrt,
    twelvePaysShipToCust : body.twelvePaysShipToCust,
    source               : 'netsuite' as const,
  };
}

// Product developers are stored as an integer[] of portal ids. NetSuite may send
// either a single `productDeveloperNsId` or an array `productDeveloperNsIds`.
async function resolveProductDeveloperIds(
  body: { productDeveloperNsId?: string | null; productDeveloperNsIds?: string[] | null },
): Promise<number[]> {
  const nsIds = body.productDeveloperNsIds?.length
    ? body.productDeveloperNsIds
    : (body.productDeveloperNsId ? [body.productDeveloperNsId] : []);
  const resolved = await Promise.all(nsIds.map(nsId => resolveNsId(productDevelopers, nsId)));
  return resolved.filter((id): id is number => id !== null);
}

async function applyEstimateUpdate(portalId: number, body: Record<string, unknown>) {
  const db = getDb();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  // Scalar fields — only set if present in body
  const scalars = ['documentNumber','projectName','customerPo','trandate','expectedCloseDate','promiseDate',
    'projectedTotalAmt','estimatedQty','deckRequest','artSetupRequest',
    'pkgDeckRequest','pkgArtSetupRequest','sampleOnlyOrder','reOrder','bibleLink','memo',
    'notesClosedLostReason','projectHoldDate','shipTo','billTo',
    'twelvePaysImportFrt','twelvePaysShipToCust'];
  for (const k of scalars) {
    if (k in body) updates[k] = body[k];
  }

  // Adjusted Pipeline — NS key differs from the column name; sanitise for NUMERIC.
  if ('adjustedPipelineAmountNS' in body) {
    updates.adjustedPipeline = numStrOrNull(body.adjustedPipelineAmountNS);
  }

  // FK fields — resolve *NsId → portal id
  const fkMap: Array<[any, string, string]> = [
    [customers,          'customerNsId',          'customerId'],
    [projectNames,       'projectNameNsId',        'projectNameId'],
    [subsidiaries,       'subsidiaryNsId',         'subsidiaryId'],
    [departments,        'departmentNsId',         'departmentId'],
    [salesChannels,      'salesChannelNsId',       'salesChannelId'],
    [businessVerticals,  'businessVerticalNsId',   'businessVerticalId'],
    [businessTypes,      'businessTypeNsId',       'businessTypeId'],
    [accountManagers,    'acctManagerNsId',        'acctManagerId'],
    [currencies,         'sellCurrencyNsId',       'sellCurrencyId'],
    [clientIncoterms,       'clientIncotermsNsId',    'clientIncotermsId'],
    [clientShippingMethods, 'clientShipMethodNsId',   'clientShipMethodId'],
    [likelyToClose,      'likelyToCloseNsId',      'likelyToCloseId'],
    [hkPartners,         'hkPartnerNsId',          'hkPartnerId'],
    [opsPartners,        'opsPartner1NsId',        'opsPartner1Id'],
    [opsPartners,        'opsPartner2NsId',        'opsPartner2Id'],
    [estimateStatuses,           'statusNsId',                   'statusId'],
    [esStatus,                   'esStatusNsId',                 'esStatusId'],
    [closedLostReasons,          'closedLostReasonNsId',         'closedLostReasonId'],
    [clientPursuitAlternatives,  'clientPursuitAlternativeNsId', 'clientPursuitAlternativeId'],
  ];
  for (const [table, nsKey, dbKey] of fkMap) {
    if (nsKey in body) {
      const resolved = await resolveNsId(table, body[nsKey] as string);
      if (resolved) updates[dbKey] = resolved;
    }
  }

  // Product developers — integer[] column; NS sends a single id or an array.
  if ('productDeveloperNsIds' in body || 'productDeveloperNsId' in body) {
    updates.productDeveloperIds = await resolveProductDeveloperIds(body as any);
  }

  const [updated] = await db.update(estimates).set(updates)
    .where(eq(estimates.id, portalId)).returning();
  return updated;
}

// ─── SYNC helpers ─────────────────────────────────────────────────

function action200(action: 'created' | 'updated'): number {
  return action === 'created' ? 201 : 200;
}

// Convert an inbound NS line item (NS internalIds) → portal DB values (portal FK ids)
async function resolveLineItemValues(item: z.infer<typeof SyncLineItemSchema>) {
  const [
    itemTypeId, vendorId, factoryId, vendorCurrencyId,
    productClassId, productClassEuId, sustainabilityId,
    vendorIncotermsId, shipToVendorId, shipToVendorAddrId, componentKitItemId,
  ] = await Promise.all([
    resolveNsId(csItems,               item.itemTypeNsId),
    resolveNsId(vendors,               item.vendorNsId),
    resolveNsId(factories,             item.factoryNsId),
    resolveNsId(currencies,            item.vendorCurrencyNsId),
    resolveNsId(productClasses,        item.productClassNsId),
    resolveNsId(productClassesEu,      item.productClassEuNsId),
    resolveNsId(sustainabilityOptions, item.sustainabilityNsId),
    resolveNsId(vendorIncoterms,       item.vendorIncotermsNsId),
    resolveNsId(vendors,               item.shipToVendorNsId),
    resolveNsId(vendorAddresses,       item.shipToVendorAddrNsId),
    resolveNsId(componentKitItems,     item.componentKitItemNsId),
  ]);

  return {
    netsuiteInternalId : item.netsuiteInternalId ?? null,
    itemTypeId, vendorId, factoryId, vendorCurrencyId,
    productClassId, productClassEuId, sustainabilityId,
    vendorIncotermsId, shipToVendorId, shipToVendorAddrId, componentKitItemId,
    shortDescription   : item.shortDescription ?? null,
    description        : item.description ?? null,
    quantity           : item.quantity ?? null,
    sellPricePerUnit   : item.sellPricePerUnit ?? null,
    skuMarginPct       : item.skuMarginPct ?? null,
    salesAmount        : item.salesAmount ?? null,
    pickupExwFob       : item.pickupExwFob ?? null,
    oceanDdp           : item.oceanDdp ?? null,
    airDdp             : item.airDdp ?? null,
    exclude            : item.exclude ?? false,
    factoryCostPerUnit : item.factoryCostPerUnit ?? null,
    packingCostPerUnit : item.packingCostPerUnit ?? null,
    sampleFees         : item.sampleFees ?? null,
    otherPerUnit       : item.otherPerUnit ?? null,
    freightPerUnit     : item.freightPerUnit ?? null,
    dutyPct            : item.dutyPct ?? null,
    tariffPct          : item.tariffPct ?? null,
    tariffMuPct        : item.tariffMuPct ?? null,
    otherCostPct       : item.otherCostPct ?? null,
    paddingPct         : item.paddingPct ?? null,
    usdFactoryCost     : item.usdFactoryCost ?? null,
    landedCostPerUnit  : item.landedCostPerUnit ?? null,
    extendedLandedCost : item.extendedLandedCost ?? null,
    htsCode            : item.htsCode ?? null,
    countryOfOrigin    : item.countryOfOrigin ?? null,
    countryOfDest      : item.countryOfDest ?? 'US',
    unitsPerCarton     : item.unitsPerCarton ?? null,
    dimLCm             : item.dimLCm ?? null,
    dimWCm             : item.dimWCm ?? null,
    dimHCm             : item.dimHCm ?? null,
    weightKgPerCarton  : item.weightKgPerCarton ?? null,
    cbmPerCarton       : item.cbmPerCarton ?? null,
    totalCartons       : item.totalCartons ?? null,
    totalCbm           : item.totalCbm ?? null,
    chargeableWeightKg : item.chargeableWeightKg ?? null,
    shippingGroupId    : item.shippingGroupId ?? null,
    exFactoryDate      : item.exFactoryDate ?? null,
    notes              : item.notes ?? null,
    trueTariff         : item.trueTariff ?? null,

    // NOTE: freight is intentionally NOT written to the line-item freight_*
    // columns. All freight lives in estimate_freight_groups, persisted from the
    // payload's freightGroups[] array (see persistNsFreightGroups).

    // Extended line fields
    paddingAmount        : item.paddingAmount ?? null,
    dutyMarkupAmount     : item.dutyMarkupAmount ?? null,
    shippingInstruction  : item.shippingInstruction ?? null,
    additionalFeeInfo    : item.additionalFeeInfo ?? null,
    vendorSku            : item.vendorSku ?? null,
    lineComponents       : item.lineComponents ?? null,
    previousLineId       : item.previousLineId ?? null,
    excludeFromPrint     : item.excludeFromPrint ?? false,
    converted            : item.converted ?? false,

    selected           : item.selected ?? true,
    syncStatus         : 'synced' as const,
    syncedAt           : new Date(),
  };
}

// Upsert all line items for an estimate, matching by NS line internal id.
// Strategy: delete all existing rows (clears lineNumber slots), then re-insert.
// Rows whose NS id matched an existing row keep that same portal id; new NS lines
// get fresh ids; existing rows absent from the payload are dropped.
async function upsertNsLineItems(
  tx: any,
  estimateId: number,
  items: Array<z.infer<typeof SyncLineItemWithComponentsSchema>>,
) {
  const existing = await tx
    .select({ id: estimateLineItems.id, nsId: estimateLineItems.netsuiteInternalId })
    .from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, estimateId));

  const nsToPortalId = new Map<string, number>();
  for (const r of existing) { if (r.nsId) nsToPortalId.set(r.nsId, r.id); }

  // Delete all — avoids (estimateId, lineNumber) unique-constraint collisions
  await tx.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId));

  if (items.length === 0) {
    return {
      parentCount: 0, componentCount: 0, deletedCount: existing.length,
      nsIdToDbId: new Map<string, number>(),
    };
  }

  let matched = 0;
  let lineCounter = 1;

  // NS line internal id -> inserted portal line id, so freight groups can
  // resolve their itemNsIds to real line ids.
  const nsIdToDbId = new Map<string, number>();

  // Pass 1: parents
  const parentIds: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const { components: _comps, ...rest } = items[i] as any;
    const vals = await resolveLineItemValues(rest);
    const portalId = vals.netsuiteInternalId ? nsToPortalId.get(vals.netsuiteInternalId) : undefined;
    if (portalId) matched++;
    const [row] = await tx.insert(estimateLineItems)
      .values({ ...(portalId ? { id: portalId } : {}), ...vals, estimateId, lineNumber: lineCounter++, sortOrder: i, parentLineItemId: null } as any)
      .returning({ id: estimateLineItems.id });
    parentIds.push(row.id);
    if (vals.netsuiteInternalId) nsIdToDbId.set(vals.netsuiteInternalId, row.id);
  }

  // Pass 2: components (nested under their parent)
  let componentCount = 0;
  for (let i = 0; i < items.length; i++) {
    const comps = (items[i] as any).components ?? [];
    for (let j = 0; j < comps.length; j++) {
      const vals = await resolveLineItemValues(comps[j]);
      const portalId = vals.netsuiteInternalId ? nsToPortalId.get(vals.netsuiteInternalId) : undefined;
      if (portalId) matched++;
      const [row] = await tx.insert(estimateLineItems)
        .values({ ...(portalId ? { id: portalId } : {}), ...vals, estimateId, lineNumber: lineCounter++, sortOrder: j, parentLineItemId: parentIds[i] } as any)
        .returning({ id: estimateLineItems.id });
      if (vals.netsuiteInternalId) nsIdToDbId.set(vals.netsuiteInternalId, row.id);
      componentCount++;
    }
  }

  return {
    parentCount  : items.length,
    componentCount,
    deletedCount : Math.max(0, existing.length - matched),
    // NS line id -> portal line id, so an explicit freightGroups[] payload can
    // resolve its itemNsIds to inserted line rows.
    nsIdToDbId,
  };
}

// Map the freight code NS sends ("FCL"/"LCL"/"AIR" or canonical) to a group mode.
function mapFreightMode(code: string | null | undefined): 'OCEAN_LCL' | 'OCEAN_FCL' | 'AIR' | 'CUSTOM' {
  const c = (code ?? '').trim().toUpperCase();
  if (c.includes('LCL')) return 'OCEAN_LCL';
  if (c.includes('FCL')) return 'OCEAN_FCL';
  if (c.includes('AIR')) return 'AIR';
  return 'CUSTOM';
}

// Sanitise a value bound for a NUMERIC column: empty/blank/non-numeric -> null
// (Postgres rejects "" for numeric, which would otherwise 500 the whole sync).
function numStrOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return Number.isFinite(Number(s)) ? s : null;
}

// ── Freight groups from an explicit NetSuite freightGroups[] payload ──────────
//
// Preferred path: NetSuite sends the groups directly. itemNsIds reference member
// lines by NS internal id (resolved to portal line ids via nsIdToDbId).
// freightModeSelected ("FCL"/"LCL"/"AIR"/… or canonical) selects the mode, and
// the single freightTotal / freightPerUnit / freightPol / freightPod are written
// into that mode's columns. Idempotent (clears prior groups + links first).
async function persistNsFreightGroups(
  tx: any,
  estimateId: number,
  groups: Array<z.infer<typeof SyncFreightGroupSchema>>,
  nsIdToDbId: Map<string, number>,
): Promise<number> {
  await tx.update(estimateLineItems)
    .set({ freightGroupId: null } as any)
    .where(eq(estimateLineItems.estimateId, estimateId));
  await tx.delete(estimateFreightGroups).where(eq(estimateFreightGroups.estimateId, estimateId));

  if (!groups || groups.length === 0) return 0;

  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    const mode = mapFreightMode(g.freightModeSelected ?? g.groupName);

    const memberIds = (g.itemNsIds ?? [])
      .map((ns) => nsIdToDbId.get(ns))
      .filter((v): v is number => typeof v === 'number');

    const total   = numStrOrNull(g.freightTotal);
    const perUnit = numStrOrNull(g.freightPerUnit);
    const pol     = g.freightPol ?? null;
    const pod     = g.freightPod ?? null;

    // Write the single freight values into the selected mode's columns.
    const modeCols: Record<string, unknown> =
        mode === 'OCEAN_LCL' ? { oceanLclTotal: total, oceanLclPerUnit: perUnit, oceanLclPol: pol, oceanLclPod: pod }
      : mode === 'OCEAN_FCL' ? { oceanFclTotal: total, oceanFclPerUnit: perUnit, oceanFclPol: pol, oceanFclPod: pod }
      : mode === 'AIR'       ? { airTotal: total, airPerUnit: perUnit, airPol: pol, airPod: pod }
      :                        { customTotal: total, customPerUnit: perUnit };

    const drayageId = g.drayageNsId ? await resolveNsId(drayage, g.drayageNsId) : null;

    const [grp] = await tx.insert(estimateFreightGroups).values({
      estimateId,
      groupName          : g.groupName ?? `Group ${idx + 1}`,
      freightModeSelected: mode,
      drayageId,
      itemIds            : memberIds,
      numItems           : g.numItems ?? memberIds.length,
      totalCartons       : g.totalCartons ?? 0,
      totalCbm           : numStrOrNull(g.totalCbm),
      totalWeight        : numStrOrNull(g.totalWeight),
      ...modeCols,
      syncStatus         : 'synced',
      syncedAt           : new Date(),
      updatedAt          : new Date(),
    } as any).returning({ id: estimateFreightGroups.id });

    if (memberIds.length > 0) {
      await tx.update(estimateLineItems)
        .set({ freightGroupId: grp.id } as any)
        .where(inArray(estimateLineItems.id, memberIds));
    }
  }

  return groups.length;
}
