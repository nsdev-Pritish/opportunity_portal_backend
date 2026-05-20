/**
 * VENDOR ADDRESS APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/vendor-addresses             → list all active vendor addresses
 *  GET   /api/v1/netsuite/cost-sheet/vendor-addresses/:nsId       → single vendor address by NS ID
 *  POST  /api/v1/netsuite/cost-sheet/vendor-addresses             → create / upsert vendor address
 *  PUT   /api/v1/netsuite/cost-sheet/vendor-addresses/:nsId       → update vendor address
 *  PUT   /api/v1/netsuite/cost-sheet/vendor-addresses/:nsId/status → activate / deactivate
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "500",
 *   "vendorNetsuiteId": "1",
 *   "attention": "John Smith",
 *   "addressee": "Acme Manufacturing Ltd",
 *   "phone": "+1-555-0100",
 *   "addrLine1": "123 Industrial Park",
 *   "addrLine2": "Building B",
 *   "city": "Chicago",
 *   "state": "IL",
 *   "zip": "60601",
 *   "country": "US"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { vendorAddresses, vendors } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  vendorNetsuiteId   : z.string().min(1),
  attention          : z.string().max(255).optional().nullable(),
  addressee          : z.string().max(255).optional().nullable(),
  phone              : z.string().max(50).optional().nullable(),
  addrLine1          : z.string().max(255).optional().nullable(),
  addrLine2          : z.string().max(255).optional().nullable(),
  city               : z.string().max(100).optional().nullable(),
  state              : z.string().max(100).optional().nullable(),
  zip                : z.string().max(20).optional().nullable(),
  country            : z.string().max(100).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true, vendorNetsuiteId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function vendorAddressRoutes(app: FastifyInstance) {

  // GET /  — list all active vendor addresses joined with vendor NS ID
  app.get('/', async () => {
    const db = getDb();
    return db
      .select({
        id                 : vendorAddresses.id,
        netsuiteInternalId : vendorAddresses.netsuiteInternalId,
        vendorId           : vendors.netsuiteInternalId,
        attention          : vendorAddresses.attention,
        addressee          : vendorAddresses.addressee,
        phone              : vendorAddresses.phone,
        addrLine1          : vendorAddresses.addrLine1,
        addrLine2          : vendorAddresses.addrLine2,
        city               : vendorAddresses.city,
        state              : vendorAddresses.state,
        zip                : vendorAddresses.zip,
        country            : vendorAddresses.country,
        isActive           : vendorAddresses.isActive,
        syncStatus         : vendorAddresses.syncStatus,
        syncedAt           : vendorAddresses.syncedAt,
        createdAt          : vendorAddresses.createdAt,
        updatedAt          : vendorAddresses.updatedAt,
      })
      .from(vendorAddresses)
      .leftJoin(vendors, eq(vendorAddresses.vendorId, vendors.id))
      .where(eq(vendorAddresses.isActive, true))
      .orderBy(vendorAddresses.addressee);
  });

  // GET /:nsId  — single vendor address
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [row] = await db
      .select({
        id                 : vendorAddresses.id,
        netsuiteInternalId : vendorAddresses.netsuiteInternalId,
        vendorId           : vendors.netsuiteInternalId,
        attention          : vendorAddresses.attention,
        addressee          : vendorAddresses.addressee,
        phone              : vendorAddresses.phone,
        addrLine1          : vendorAddresses.addrLine1,
        addrLine2          : vendorAddresses.addrLine2,
        city               : vendorAddresses.city,
        state              : vendorAddresses.state,
        zip                : vendorAddresses.zip,
        country            : vendorAddresses.country,
        isActive           : vendorAddresses.isActive,
        syncStatus         : vendorAddresses.syncStatus,
        syncedAt           : vendorAddresses.syncedAt,
        createdAt          : vendorAddresses.createdAt,
        updatedAt          : vendorAddresses.updatedAt,
      })
      .from(vendorAddresses)
      .leftJoin(vendors, eq(vendorAddresses.vendorId, vendors.id))
      .where(eq(vendorAddresses.netsuiteInternalId, req.params.nsId))
      .limit(1);
    if (!row) throw new NotFoundError('VendorAddress', req.params.nsId);
    return row;
  });

  // POST /  — create or upsert vendor address
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    console.log('Upserting vendor address with NS ID:', body.vendorNetsuiteId, body.netsuiteInternalId);

    const [vendor] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.netsuiteInternalId, body.vendorNetsuiteId))
      .limit(1);
    if (!vendor) throw new ValidationError(`Vendor with NetSuite ID ${body.vendorNetsuiteId} not found`);

    const [existing] = await db
      .select({ id: vendorAddresses.id })
      .from(vendorAddresses)
      .where(eq(vendorAddresses.netsuiteInternalId, body.netsuiteInternalId))
      .limit(1);

    if (existing) {
      const [upd] = await db.update(vendorAddresses)
        .set({
          vendorId   : vendor.id,
          attention  : body.attention,
          addressee  : body.addressee,
          phone      : body.phone,
          addrLine1  : body.addrLine1,
          addrLine2  : body.addrLine2,
          city       : body.city,
          state      : body.state,
          zip        : body.zip,
          country    : body.country,
          syncStatus : 'synced',
          syncedAt   : new Date(),
          updatedAt  : new Date(),
        })
        .where(eq(vendorAddresses.id, existing.id))
        .returning();
      await invalidateDropdown('vendor_addresses');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(vendorAddresses)
      .values({
        netsuiteInternalId : body.netsuiteInternalId,
        vendorId           : vendor.id,
        attention          : body.attention,
        addressee          : body.addressee,
        phone              : body.phone,
        addrLine1          : body.addrLine1,
        addrLine2          : body.addrLine2,
        city               : body.city,
        state              : body.state,
        zip                : body.zip,
        country            : body.country,
        source             : 'netsuite',
        syncStatus         : 'synced',
        syncedAt           : new Date(),
      })
      .returning();
    await invalidateDropdown('vendor_addresses');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /:nsId  — update vendor address
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: vendorAddresses.id })
      .from(vendorAddresses)
      .where(eq(vendorAddresses.netsuiteInternalId, req.params.nsId))
      .limit(1);
    if (!existing) throw new NotFoundError('VendorAddress', req.params.nsId);

    const [updated] = await db.update(vendorAddresses)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorAddresses.id, existing.id))
      .returning();
    await invalidateDropdown('vendor_addresses');
    return updated;
  });

  // PUT /:nsId/status  — activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: vendorAddresses.id })
      .from(vendorAddresses)
      .where(eq(vendorAddresses.netsuiteInternalId, req.params.nsId))
      .limit(1);
    if (!existing) throw new NotFoundError('VendorAddress', req.params.nsId);

    const [updated] = await db.update(vendorAddresses)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorAddresses.id, existing.id))
      .returning({
        id                 : vendorAddresses.id,
        netsuiteInternalId : vendorAddresses.netsuiteInternalId,
        isActive           : vendorAddresses.isActive,
      });
    await invalidateDropdown('vendor_addresses');
    return updated;
  });
}
