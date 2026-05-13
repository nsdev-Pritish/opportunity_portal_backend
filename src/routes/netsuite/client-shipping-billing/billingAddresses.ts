/**
 * CLIENT BILLING ADDRESS APIs
 * Shared table: addresses (type = 'billing')
 *
 *  GET   /api/v1/netsuite/client-billing-addresses
 *  GET   /api/v1/netsuite/client-billing-addresses/:nsId
 *  POST  /api/v1/netsuite/client-billing-addresses
 *  PUT   /api/v1/netsuite/client-billing-addresses/:nsId
 *  PUT   /api/v1/netsuite/client-billing-addresses/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "101",
 *   "customerNetsuiteId": "1234",
 *   "companyName": "Acme Corp",
 *   "attention": "John Smith",
 *   "addressee": "Acme Corporation",
 *   "phone": "+1-555-0100",
 *   "country": "US",
 *   "addrLine1": "123 Main St",
 *   "addrLine2": "Suite 100",
 *   "city": "New York",
 *   "state": "NY",
 *   "postalCode": "10001"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { addresses, customers } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const ADDRESS_TYPE = 'billing';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  customerNetsuiteId : z.string().min(1),
  companyName        : z.string().max(255).optional().nullable(),
  attention          : z.string().max(255).optional().nullable(),
  addressee          : z.string().max(255).optional().nullable(),
  phone              : z.string().max(50).optional().nullable(),
  country            : z.string().max(100).optional().nullable(),
  addrLine1          : z.string().max(255).optional().nullable(),
  addrLine2          : z.string().max(255).optional().nullable(),
  city               : z.string().max(100).optional().nullable(),
  state              : z.string().max(100).optional().nullable(),
  postalCode         : z.string().max(20).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true, customerNetsuiteId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function billingAddressRoutes(app: FastifyInstance) {

  // GET /  — list all active billing addresses with customer NS ID
  app.get('/', async () => {
    const db = getDb();
    const rows = await db
      .select({
        id                 : addresses.id,
        netsuiteInternalId : addresses.netsuiteInternalId,
        type               : addresses.type,
        companyName        : addresses.companyName,
        customerId         : customers.netsuiteInternalId,
        country            : addresses.country,
        attention          : addresses.attention,
        addressee          : addresses.addressee,
        phone              : addresses.phone,
        addrLine1          : addresses.addrLine1,
        addrLine2          : addresses.addrLine2,
        city               : addresses.city,
        state              : addresses.state,
        postalCode         : addresses.postalCode,
        isActive           : addresses.isActive,
        syncStatus         : addresses.syncStatus,
        syncedAt           : addresses.syncedAt,
        createdAt          : addresses.createdAt,
        updatedAt          : addresses.updatedAt,
      })
      .from(addresses)
      .leftJoin(customers, eq(addresses.customerId, customers.id))
      .where(and(eq(addresses.isActive, true), eq(addresses.type, ADDRESS_TYPE)))
      .orderBy(addresses.companyName);
    return rows;
  });

  // GET /:nsId  — single billing address
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [row] = await db
      .select({
        id                 : addresses.id,
        netsuiteInternalId : addresses.netsuiteInternalId,
        type               : addresses.type,
        companyName        : addresses.companyName,
        customerId         : customers.netsuiteInternalId,
        country            : addresses.country,
        attention          : addresses.attention,
        addressee          : addresses.addressee,
        phone              : addresses.phone,
        addrLine1          : addresses.addrLine1,
        addrLine2          : addresses.addrLine2,
        city               : addresses.city,
        state              : addresses.state,
        postalCode         : addresses.postalCode,
        isActive           : addresses.isActive,
        syncStatus         : addresses.syncStatus,
        syncedAt           : addresses.syncedAt,
        createdAt          : addresses.createdAt,
        updatedAt          : addresses.updatedAt,
      })
      .from(addresses)
      .leftJoin(customers, eq(addresses.customerId, customers.id))
      .where(and(
        eq(addresses.netsuiteInternalId, req.params.nsId),
        eq(addresses.type, ADDRESS_TYPE),
      ))
      .limit(1);
    if (!row) throw new NotFoundError('BillingAddress', req.params.nsId);
    return row;
  });

  // POST /  — create or upsert billing address
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.netsuiteInternalId, body.customerNetsuiteId))
      .limit(1);
    if (!customer) throw new ValidationError(`Customer with NetSuite ID ${body.customerNetsuiteId} not found`);

    const [existing] = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(
        eq(addresses.netsuiteInternalId, body.netsuiteInternalId),
        eq(addresses.type, ADDRESS_TYPE),
      ))
      .limit(1);

    if (existing) {
      const [upd] = await db.update(addresses)
        .set({
          customerId  : customer.id,
          companyName : body.companyName,
          attention   : body.attention,
          addressee   : body.addressee,
          phone       : body.phone,
          country     : body.country,
          addrLine1   : body.addrLine1,
          addrLine2   : body.addrLine2,
          city        : body.city,
          state       : body.state,
          postalCode  : body.postalCode,
          syncStatus  : 'synced',
          syncedAt    : new Date(),
          updatedAt   : new Date(),
        })
        .where(eq(addresses.id, existing.id))
        .returning();
      await invalidateDropdown('addresses');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(addresses)
      .values({
        netsuiteInternalId : body.netsuiteInternalId,
        customerId         : customer.id,
        type               : ADDRESS_TYPE,
        companyName        : body.companyName,
        attention          : body.attention,
        addressee          : body.addressee,
        phone              : body.phone,
        country            : body.country,
        addrLine1          : body.addrLine1,
        addrLine2          : body.addrLine2,
        city               : body.city,
        state              : body.state,
        postalCode         : body.postalCode,
        source             : 'netsuite',
        syncStatus         : 'synced',
        syncedAt           : new Date(),
      })
      .returning();
    await invalidateDropdown('addresses');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /:nsId  — update billing address
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(
        eq(addresses.netsuiteInternalId, req.params.nsId),
        eq(addresses.type, ADDRESS_TYPE),
      ))
      .limit(1);
    if (!existing) throw new NotFoundError('BillingAddress', req.params.nsId);

    const [updated] = await db.update(addresses)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(addresses.id, existing.id))
      .returning();
    await invalidateDropdown('addresses');
    return updated;
  });

  // PUT /:nsId/status  — activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(
        eq(addresses.netsuiteInternalId, req.params.nsId),
        eq(addresses.type, ADDRESS_TYPE),
      ))
      .limit(1);
    if (!existing) throw new NotFoundError('BillingAddress', req.params.nsId);

    const [updated] = await db.update(addresses)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(addresses.id, existing.id))
      .returning({
        id                 : addresses.id,
        netsuiteInternalId : addresses.netsuiteInternalId,
        type               : addresses.type,
        isActive           : addresses.isActive,
      });
    await invalidateDropdown('addresses');
    return updated;
  });
}
