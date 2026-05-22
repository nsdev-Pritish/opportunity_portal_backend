import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listEstimates,
  getEstimate,
  createEstimateWithItems,
  updateEstimateWithItems,
  deactivateEstimate,
} from '../../services/estimate.service.js';

// ── Line item schema (mirrors every estimate_line_items column) ─────────────
const LineItemSchema = z.object({
  // ── Line header ────────────────────────────────────────────────────────────
  itemTypeId: z.number().int().positive().optional(),        // Item Type dropdown
  shortDescription: z.string().max(500).optional(),          // Short Description text
  vendorId: z.number().int().positive().optional(),          // Vendor dropdown
  quantity: z.string().optional(),                           // Quantity
  sellPricePerUnit: z.string().optional(),                   // Sell Price (per unit)
  skuMarginPct: z.string().optional(),                       // SKU Margin % (calculated, displayed)
  salesAmount: z.string().optional(),                        // Sales Amount (calculated: sellPrice × qty)
  pickupExwFob: z.string().optional(),                       // Pick-up (EXW/FOB) optional column
  oceanDdp: z.string().optional(),                           // Ocean DDP optional column
  airDdp: z.string().optional(),                             // Air DDP optional column
  exclude: z.boolean().optional(),                           // Exclude checkbox

  // ── Purchase Information ───────────────────────────────────────────────────
  description: z.string().optional(),                        // Description textarea
  factoryId: z.number().int().positive().optional(),         // Factory Name dropdown
  vendorCurrencyId: z.number().int().positive().optional(),  // Vendor Currency dropdown
  factoryCostPerUnit: z.string().optional(),                 // Factory Cost (per unit)
  packingCostPerUnit: z.string().optional(),                 // Packing Cost (per unit)
  sampleFees: z.string().optional(),                         // Sample Fees
  otherPerUnit: z.string().optional(),                       // Other (per unit)

  // ── Landed Cost ────────────────────────────────────────────────────────────
  landedCostPerUnit: z.string().optional(),                  // Landed Cost (per unit) — calculated
  extendedLandedCost: z.string().optional(),                 // Extended Landed Cost — calculated
  freightPerUnit: z.string().optional(),                     // Freight (/unit)
  dutyPct: z.string().optional(),                            // Duty (%)
  tariffPct: z.string().optional(),                          // Tariff (%)
  tariffMuPct: z.string().optional(),                        // Tariff MU (%)
  otherCostPct: z.string().optional(),                       // Other %
  usdFactoryCost: z.string().optional(),                     // USD Factory Cost (per unit) — calculated
  paddingPct: z.string().optional(),                         // Padding (%)

  // ── Classification ─────────────────────────────────────────────────────────
  productClassId: z.number().int().positive().optional(),    // Product Class dropdown
  sustainabilityId: z.number().int().positive().optional(),  // Sustainability dropdown
  htsCode: z.string().max(20).optional(),                    // HTS Code text
  countryOfOrigin: z.string().max(100).optional(),           // Country of Origin text
  countryOfDest: z.enum(['US', 'EU']).optional(),            // Country of Destination toggle (US / EU)

  // ── Packing Details ────────────────────────────────────────────────────────
  unitsPerCarton: z.number().int().positive().optional(),    // Units per Carton
  dimLCm: z.string().optional(),                             // Dimension L (cm)
  dimWCm: z.string().optional(),                             // Dimension W (cm)
  dimHCm: z.string().optional(),                             // Dimension H (cm)
  weightKgPerCarton: z.string().optional(),                  // Weight KG (per Carton)
  totalCartons: z.number().int().nonnegative().optional(),   // Total # Cartons — calculated
  cbmPerCarton: z.string().optional(),                       // CBM per Carton — calculated
  totalCbm: z.string().optional(),                           // Total CBM — calculated
  chargeableWeightKg: z.string().optional(),                 // Chargeable Weight KG — calculated
  shippingGroupId: z.number().int().positive().optional(),   // Shipping Group dropdown

  // ── Other Details (Vendor Only) ────────────────────────────────────────────
  exFactoryDate: z.string().optional(),                      // Ex-Factory Date
  vendorIncotermsId: z.number().int().positive().optional(), // Vendor Incoterms dropdown
  shipToVendorId: z.number().int().positive().optional(),    // Ship to Vendor dropdown
  shipToVendorAddrId: z.number().int().positive().optional(),// Ship to Vendor Address dropdown
  notes: z.string().optional(),                              // Notes textarea
});

// ── Estimate header schema ──────────────────────────────────────────────────
const EstimateHeaderSchema = z.object({
  // Primary Information
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
  productDeveloperId: z.number().int().positive().optional(),
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

// POST body: header + optional cost sheet items (up to 400)
const CreateEstimateSchema = EstimateHeaderSchema.extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
});

// PATCH body: all header fields optional + optional full line-item replacement
const UpdateEstimateSchema = EstimateHeaderSchema.partial().extend({
  lineItems: z.array(LineItemSchema).max(400).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────

export default async function estimateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

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

  // POST /api/v1/estimates — create estimate + cost sheet items atomically
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { lineItems, ...headerData } = CreateEstimateSchema.parse(req.body);
    const result = await createEstimateWithItems(
      { ...headerData, createdBy: (req as any).user.id },
      lineItems ?? [],
    );
    return reply.status(201).send(result);
  });

  // GET /api/v1/estimates/:id — full estimate with line items
  app.get<{ Params: { id: string } }>('/:id', async (req) =>
    getEstimate(parseInt(req.params.id)),
  );

  // PATCH /api/v1/estimates/:id — update header; if lineItems provided, replaces all items atomically
  app.patch<{ Params: { id: string }; Body: unknown }>('/:id', async (req) => {
    const { lineItems, ...headerData } = UpdateEstimateSchema.parse(req.body);
    return updateEstimateWithItems(
      parseInt(req.params.id),
      { ...headerData, updatedBy: (req as any).user.id },
      lineItems,
    );
  });

  // DELETE /api/v1/estimates/:id — soft-delete
  app.delete<{ Params: { id: string } }>('/:id', async (req) =>
    deactivateEstimate(parseInt(req.params.id)),
  );
}
