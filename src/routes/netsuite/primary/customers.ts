/**
 * CUSTOMER APIs
 * Called by NetSuite SuiteScript when a customer is created or changed.
 *
 *  POST  /api/v1/netsuite/customers          → create customer
 *  PUT   /api/v1/netsuite/customers/:nsId    → update customer
 *  PUT   /api/v1/netsuite/customers/:nsId/status → activate / deactivate
 *  GET   /api/v1/netsuite/customers          → list all active customers
 *  GET   /api/v1/netsuite/customers/:nsId    → get single customer
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { customers, subsidiaries, currencies, obcPodRegions, accountManagers } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

// ─── Validation schemas ───────────────────────────────────────────

const CreateCustomerSchema = z.object({
  netsuiteInternalId     : z.string().min(1),   // NS internalId — required
  subsidiaryNetsuiteId   : z.string().min(1),   // NS internalId of the subsidiary
  name                   : z.string().min(1).max(255),
  parentCompany          : z.string().max(255).optional().nullable(),
  salesRep               : z.string().max(255).optional().nullable(),   // Sales Rep name
  salesRepNsId           : z.string().max(50).optional().nullable(),    // NS internalId of the Sales Rep employee
  contactName            : z.string().max(255).optional().nullable(),
  email                  : z.string().max(255).optional().nullable(),
  phone                  : z.string().max(50).optional().nullable(),
  terms                  : z.string().max(100).optional().nullable(),
  chargebackRoyalties    : z.number().optional().nullable(),
  currencyNsId           : z.string().optional().nullable(),   // NS internalId of currency
  podRegionNsId          : z.string().optional().nullable(),   // NS internalId of OBC POD Region
});

const UpdateCustomerSchema = z.object({
  subsidiaryNetsuiteId   : z.string().min(1).optional(), // NS internalId of the subsidiary
  name                   : z.string().min(1).max(255).optional(),
  parentCompany          : z.string().max(255).optional().nullable(),
  salesRep               : z.string().max(255).optional().nullable(),   // Sales Rep name
  salesRepNsId           : z.string().max(50).optional().nullable(),    // NS internalId of the Sales Rep employee
  contactName            : z.string().max(255).optional().nullable(),
  email                  : z.string().max(255).optional().nullable(),
  phone                  : z.string().max(50).optional().nullable(),
  terms                  : z.string().max(100).optional().nullable(),
  chargebackRoyalties    : z.number().optional().nullable(),
  currencyNsId           : z.string().optional().nullable(),   // NS internalId of currency
  podRegionNsId          : z.string().optional().nullable(),   // NS internalId of OBC POD Region
});

const StatusSchema = z.object({
  isActive : z.boolean(),
});

// ─── Route handler ────────────────────────────────────────────────

export default async function customerRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/customers ──────────────────────────────
  // Returns all active customers.
  // NS uses this to populate the Customer dropdown.
  app.get('/', async () => {
    const db = getDb();
    return db
      .select()
      .from(customers)
      .where(eq(customers.isActive, true))
      .orderBy(customers.name);
  });

  // ── GET /api/v1/netsuite/customers/:nsId ────────────────────────
  // Returns a single customer by NS internalId.
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.netsuiteInternalId, req.params.nsId))
      .limit(1);
    if (!row) throw new NotFoundError('Customer', req.params.nsId);
    return row;
  });

  // ── POST /api/v1/netsuite/customers ─────────────────────────────
  // NetSuite creates a new customer.
  // If the same netsuiteInternalId already exists → updates it (idempotent).
  //
  // Body:
  //   { "netsuiteInternalId": "1234", "subsidiaryNetsuiteId": "5", "name": "Acme Corp", "email": "x@acme.com" }
  //
  // Response: the created/updated customer row
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateCustomerSchema.parse(req.body);
    const db = getDb();

    // Look up subsidiary by NetSuite internal ID to get local database ID
    const [subsidiary] = await db
      .select({ id: subsidiaries.id })
      .from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, body.subsidiaryNetsuiteId))
      .limit(1);
    
    if (!subsidiary) {
      throw new ValidationError(`Subsidiary with NetSuite ID ${body.subsidiaryNetsuiteId} not found`);
    }

    // Resolve currency by NetSuite internal ID
    let currencyId: number | null = null;
    if (body.currencyNsId) {
      const [curr] = await db
        .select({ id: currencies.id })
        .from(currencies)
        .where(eq(currencies.netsuiteInternalId, body.currencyNsId))
        .limit(1);
      if (curr) currencyId = curr.id;
    }

    // Resolve OBC POD Region by NetSuite internal ID
    let podRegionId: number | null = null;
    if (body.podRegionNsId) {
      const [region] = await db
        .select({ id: obcPodRegions.id })
        .from(obcPodRegions)
        .where(eq(obcPodRegions.netsuiteInternalId, body.podRegionNsId))
        .limit(1);
      if (region) podRegionId = region.id;
    }

    // Resolve Sales Rep → local account_managers.id by NetSuite internal ID.
    // (NetSuite sends the rep's NS id; the UI needs the local id to drive Acct Manager.)
    let salesRepId: number | null = null;
    if (body.salesRepNsId) {
      const [rep] = await db
        .select({ id: accountManagers.id })
        .from(accountManagers)
        .where(eq(accountManagers.netsuiteInternalId, body.salesRepNsId))
        .limit(1);
      if (rep) salesRepId = rep.id;
    }

    // Idempotency: same NS id already exists → update instead of duplicate
    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.netsuiteInternalId, body.netsuiteInternalId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(customers)
        .set({
          subsidiaryId: subsidiary.id,
          name: body.name,
          parentCompany: body.parentCompany,
          salesRep: body.salesRep,
          salesRepNsId: body.salesRepNsId,
          salesRepId,
          contactName: body.contactName,
          email: body.email,
          phone: body.phone,
          terms: body.terms,
          chargebackRoyalties: body.chargebackRoyalties != null ? String(body.chargebackRoyalties) : body.chargebackRoyalties,
          currencyId,
          podRegionId,
          updatedAt: new Date()
        })
        .where(eq(customers.id, existing.id))
        .returning();
      await invalidateDropdown('customers');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const [created] = await db
      .insert(customers)
      .values({
        netsuiteInternalId : body.netsuiteInternalId,
        subsidiaryId       : subsidiary.id, // Use the local database ID
        name               : body.name,
        parentCompany      : body.parentCompany,
        salesRep           : body.salesRep,
        salesRepNsId       : body.salesRepNsId,
        salesRepId,
        contactName        : body.contactName,
        email              : body.email,
        phone              : body.phone,
        terms              : body.terms,
        chargebackRoyalties: body.chargebackRoyalties != null ? String(body.chargebackRoyalties) : body.chargebackRoyalties,
        currencyId,
        podRegionId,
        source             : 'netsuite',
        syncStatus         : 'synced',
        syncedAt           : new Date(),
      })
      .returning();

    await invalidateDropdown('customers');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/customers/:nsId ────────────────────────
  // NetSuite updates an existing customer.
  // :nsId = the NS internalId (e.g. "1234")
  //
  // Body: any subset of { subsidiaryNetsuiteId, name, email, phone }
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateCustomerSchema.parse(req.body);
    const db = getDb();

    // Look up subsidiary by NetSuite internal ID if provided
    let subsidiaryId: number | undefined;
    if (body.subsidiaryNetsuiteId !== undefined) {
      const [subsidiary] = await db
        .select({ id: subsidiaries.id })
        .from(subsidiaries)
        .where(eq(subsidiaries.netsuiteInternalId, body.subsidiaryNetsuiteId))
        .limit(1);
      
      if (!subsidiary) {
        throw new ValidationError(`Subsidiary with NetSuite ID ${body.subsidiaryNetsuiteId} not found`);
      }
      subsidiaryId = subsidiary.id;
    }

    // Resolve currency by NetSuite internal ID if provided
    let currencyId: number | null | undefined = undefined;
    if (body.currencyNsId !== undefined) {
      if (body.currencyNsId) {
        const [curr] = await db
          .select({ id: currencies.id })
          .from(currencies)
          .where(eq(currencies.netsuiteInternalId, body.currencyNsId))
          .limit(1);
        currencyId = curr ? curr.id : null;
      } else {
        currencyId = null;
      }
    }

    // Resolve OBC POD Region by NetSuite internal ID if provided
    let podRegionId: number | null | undefined = undefined;
    if (body.podRegionNsId !== undefined) {
      if (body.podRegionNsId) {
        const [region] = await db
          .select({ id: obcPodRegions.id })
          .from(obcPodRegions)
          .where(eq(obcPodRegions.netsuiteInternalId, body.podRegionNsId))
          .limit(1);
        podRegionId = region ? region.id : null;
      } else {
        podRegionId = null;
      }
    }

    // Resolve Sales Rep → local account_managers.id by NetSuite internal ID if provided
    let salesRepId: number | null | undefined = undefined;
    if (body.salesRepNsId !== undefined) {
      if (body.salesRepNsId) {
        const [rep] = await db
          .select({ id: accountManagers.id })
          .from(accountManagers)
          .where(eq(accountManagers.netsuiteInternalId, body.salesRepNsId))
          .limit(1);
        salesRepId = rep ? rep.id : null;
      } else {
        salesRepId = null;
      }
    }

    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.netsuiteInternalId, req.params.nsId))
      .limit(1);

    if (!existing) throw new NotFoundError('Customer', req.params.nsId);

    const updateData: any = {
      syncStatus: 'synced',
      syncedAt: new Date(),
      updatedAt: new Date(),
    };
    if (subsidiaryId !== undefined) updateData.subsidiaryId = subsidiaryId;
    if (body.name !== undefined) updateData.name = body.name;
    if (body.parentCompany !== undefined) updateData.parentCompany = body.parentCompany;
    if (body.salesRep !== undefined) updateData.salesRep = body.salesRep;
    if (body.salesRepNsId !== undefined) updateData.salesRepNsId = body.salesRepNsId;
    if (salesRepId !== undefined) updateData.salesRepId = salesRepId;
    if (body.contactName !== undefined) updateData.contactName = body.contactName;
    if (body.email !== undefined) updateData.email = body.email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.terms !== undefined) updateData.terms = body.terms;
    if (body.chargebackRoyalties !== undefined) updateData.chargebackRoyalties = body.chargebackRoyalties != null ? String(body.chargebackRoyalties) : null;
    if (currencyId !== undefined) updateData.currencyId = currencyId;
    if (podRegionId !== undefined) updateData.podRegionId = podRegionId;

    const [updated] = await db
      .update(customers)
      .set(updateData)
      .where(eq(customers.id, existing.id))
      .returning();

    await invalidateDropdown('customers');
    return updated;
  });

  // ── PATCH /api/v1/netsuite/customers/:nsId/status ───────────────
  // Activate or deactivate a customer.
  // Body: { "isActive": false }
  //
  // When isActive=false: customer disappears from dropdowns.
  // Existing estimates referencing this customer are NOT affected.
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.netsuiteInternalId, req.params.nsId))
      .limit(1);

    if (!existing) throw new NotFoundError('Customer', req.params.nsId);

    const [updated] = await db
      .update(customers)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(customers.id, existing.id))
      .returning({ id: customers.id, netsuiteInternalId: customers.netsuiteInternalId, isActive: customers.isActive });

    await invalidateDropdown('customers');
    return updated;
  });
}
