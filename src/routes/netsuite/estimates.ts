/**
 * ESTIMATE APIs
 * Called by NetSuite SuiteScript when an estimate is created or changed.
 *
 *  POST   /api/v1/netsuite/estimates                → create estimate (without line items)
 *  POST   /api/v1/netsuite/estimates/with-items     → create estimate WITH line items (atomic)
 *  PUT    /api/v1/netsuite/estimates/:nsId          → update estimate
 *  DELETE /api/v1/netsuite/estimates/:nsId          → deactivate estimate
 *  GET    /api/v1/netsuite/estimates                → list estimates
 *  GET    /api/v1/netsuite/estimates/:nsId          → get single estimate + line items
 *
 * IMPORTANT ORDER: Push customers/departments/employees BEFORE estimates.
 * Estimates reference those records by NS internalId.
 */

import { FastifyInstance } from 'fastify';
import { eq, desc, asc } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import {
  estimates, estimateLineItems,
  customers, contacts, currencies, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  employees, hkPartners, opsPartners, compliancePartners,
  clientIncoterms, clientShippingMethods, addresses,
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
  projectName          : z.string().min(1).max(255),
  customerNsId         : z.string().min(1),  // NS internalId of the customer

  // Optional — send NS internalIds for each lookup field
  customerContactNsId  : z.string().optional().nullable(),
  customerPo           : z.string().max(100).optional().nullable(),
  projectTypeNsId      : z.string().optional().nullable(),
  expectedCloseDate    : z.string().optional().nullable(),  // "YYYY-MM-DD"
  promiseDate          : z.string().optional().nullable(),
  likelyToCloseNsId    : z.string().optional().nullable(),
  sellCurrencyNsId     : z.string().optional().nullable(),
  projectedTotalAmt    : z.string().optional().nullable(),
  estimatedQty         : z.number().int().optional().nullable(),

  // Classification
  departmentNsId       : z.string().optional().nullable(),
  salesChannelNsId     : z.string().optional().nullable(),
  businessVerticalNsId : z.string().optional().nullable(),
  businessTypeNsId     : z.string().optional().nullable(),
  compliancePartnerNsId: z.string().optional().nullable(),
  acctManagerNsId      : z.string().optional().nullable(),
  productDeveloperNsId : z.string().optional().nullable(),
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

  // Additional
  sampleOnlyOrder      : z.boolean().optional(),
  reOrder              : z.boolean().optional(),
  bibleLink            : z.string().optional().nullable(),
  memo                 : z.string().optional().nullable(),
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
  shippingGroupId     : z.number().int().optional().nullable(),
  exFactoryDate       : z.string().optional().nullable(),
  vendorIncotermsId   : z.number().int().optional().nullable(),
  shipToVendorId      : z.number().int().optional().nullable(),
  notes               : z.string().optional().nullable(),
  exclude             : z.boolean().optional(),
  pickupExwFob        : z.string().optional().nullable(),
  oceanDdp            : z.string().optional().nullable(),
  airDdp              : z.string().optional().nullable(),
});

// Combined Schema: Create estimate WITH line items in single transaction
const CreateEstimateWithItemsSchema = z.object({
  estimate  : CreateEstimateSchema,
  lineItems : z.array(LineItemSchema).max(400).optional(), // up to 400 line items
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
    projectName          : body.projectName,
    customerId,
    customerContactId    : await resolveNsId(contacts,           body.customerContactNsId),
    customerPo           : body.customerPo,
    projectTypeId        : await resolveNsId(projectTypes,       body.projectTypeNsId),
    expectedCloseDate    : body.expectedCloseDate,
    promiseDate          : body.promiseDate,
    likelyToCloseId      : await resolveNsId(likelyToClose,      body.likelyToCloseNsId),
    sellCurrencyId       : await resolveNsId(currencies,         body.sellCurrencyNsId),
    projectedTotalAmt    : body.projectedTotalAmt,
    estimatedQty         : body.estimatedQty,
    departmentId         : await resolveNsId(departments,        body.departmentNsId),
    salesChannelId       : await resolveNsId(salesChannels,      body.salesChannelNsId),
    businessVerticalId   : await resolveNsId(businessVerticals,  body.businessVerticalNsId),
    businessTypeId       : await resolveNsId(businessTypes,      body.businessTypeNsId),
    compliancePartnerId  : await resolveNsId(compliancePartners, body.compliancePartnerNsId),
    acctManagerId        : await resolveNsId(employees,          body.acctManagerNsId),
    productDeveloperId   : await resolveNsId(employees,          body.productDeveloperNsId),
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
    sampleOnlyOrder      : body.sampleOnlyOrder ?? false,
    reOrder              : body.reOrder         ?? false,
    bibleLink            : body.bibleLink,
    memo                 : body.memo,
    source               : 'netsuite' as const,
  };
}

async function applyEstimateUpdate(portalId: number, body: Record<string, unknown>) {
  const db = getDb();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  // Scalar fields — only set if present in body
  const scalars = ['projectName','customerPo','expectedCloseDate','promiseDate',
    'projectedTotalAmt','estimatedQty','deckRequest','artSetupRequest',
    'pkgDeckRequest','pkgArtSetupRequest','sampleOnlyOrder','reOrder','bibleLink','memo'];
  for (const k of scalars) {
    if (k in body) updates[k] = body[k];
  }

  // FK fields — resolve *NsId → portal id
  const fkMap: Array<[any, string, string]> = [
    [customers,          'customerNsId',          'customerId'],
    [departments,        'departmentNsId',         'departmentId'],
    [salesChannels,      'salesChannelNsId',       'salesChannelId'],
    [businessVerticals,  'businessVerticalNsId',   'businessVerticalId'],
    [businessTypes,      'businessTypeNsId',       'businessTypeId'],
    [employees,          'acctManagerNsId',        'acctManagerId'],
    [employees,          'productDeveloperNsId',   'productDeveloperId'],
    [currencies,         'sellCurrencyNsId',       'sellCurrencyId'],
    [clientIncoterms,       'clientIncotermsNsId',    'clientIncotermsId'],
    [clientShippingMethods, 'clientShipMethodNsId',   'clientShipMethodId'],
    [likelyToClose,      'likelyToCloseNsId',      'likelyToCloseId'],
    [hkPartners,         'hkPartnerNsId',          'hkPartnerId'],
    [opsPartners,        'opsPartner1NsId',        'opsPartner1Id'],
    [opsPartners,        'opsPartner2NsId',        'opsPartner2Id'],
  ];
  for (const [table, nsKey, dbKey] of fkMap) {
    if (nsKey in body) {
      const resolved = await resolveNsId(table, body[nsKey] as string);
      if (resolved) updates[dbKey] = resolved;
    }
  }

  const [updated] = await db.update(estimates).set(updates)
    .where(eq(estimates.id, portalId)).returning();
  return updated;
}
