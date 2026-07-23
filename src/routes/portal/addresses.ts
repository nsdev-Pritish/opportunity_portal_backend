/**
 * PORTAL — Address Routes
 *
 *  POST /api/v1/portal/addresses/shipping          → create new shipping address (from modal)
 *  POST /api/v1/portal/addresses/billing           → create new billing address (from modal)
 *  GET  /api/v1/portal/addresses/shipping?customerId=5  → list shipping addresses for customer
 *  GET  /api/v1/portal/addresses/billing?customerId=5   → list billing addresses for customer
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { addresses, customers } from '../../db/schema/index.js';
import { invalidateDropdown } from '../../utils/cache.js';
import { ValidationError } from '../../utils/errors.js';
import {
  syncShippingAddressToNetsuite,
  syncBillingAddressToNetsuite,
} from '../../services/portalNetsuiteSync.service.js';

const CreateAddressBody = z.object({
  customerId: z.number({ required_error: 'Customer is required' }).int().positive(),
  type: z.enum(['shipping', 'billing']).optional().default('shipping'),
  label: z.string().max(500).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  attention: z.string().max(255).optional().nullable(),
  addressee: z.string().max(255).optional().nullable(),
  addrLine1: z.string().max(255).optional().nullable(),
  addrLine2: z.string().max(255).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  companyName: z.string().max(255).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
});

async function createAddress(body: z.infer<typeof CreateAddressBody>, type: 'shipping' | 'billing') {
  const db = getDb();

  const [customer] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(eq(customers.id, body.customerId))
    .limit(1);

  if (!customer) {
    throw new ValidationError(`Customer with id '${body.customerId}' not found.`);
  }

  const [created] = await db
    .insert(addresses)
    .values({
      customerId: body.customerId,
      type,
      label: body.label ?? null,
      country: body.country ?? null,
      attention: body.attention ?? null,
      addressee: body.addressee ?? null,
      addrLine1: body.addrLine1 ?? null,
      addrLine2: body.addrLine2 ?? null,
      city: body.city ?? null,
      state: body.state ?? null,
      postalCode: body.postalCode ?? null,
      companyName: body.companyName ?? null,
      phone: body.phone ?? null,
      source: 'portal',
      syncStatus: 'pending',
    })
    .returning();

  await invalidateDropdown('addresses');

  // Push to NetSuite and store the returned internal id back on the row.
  // Non-throwing: if NS is down/unconfigured the record stays syncStatus='pending'.
  const ns = type === 'billing'
    ? await syncBillingAddressToNetsuite(created.id)
    : await syncShippingAddressToNetsuite(created.id);
  await invalidateDropdown('addresses');

  // If NetSuite matched an existing address, the sync deduped to that row and the
  // just-created duplicate was removed — return the existing record instead.
  if (ns.id && ns.id !== created.id) {
    const [existing] = await db.select().from(addresses).where(eq(addresses.id, ns.id)).limit(1);
    if (existing) {
      return { ...existing, customerName: customer.name, _deduped: true };
    }
  }

  return {
    ...created,
    netsuiteInternalId: ns.netsuiteInternalId ?? created.netsuiteInternalId,
    syncStatus: ns.syncStatus,
    syncError: ns.syncError,
    customerName: customer.name,
  };
}

async function listAddresses(customerId: number | undefined, type: 'shipping' | 'billing') {
  const db = getDb();

  const conditions = customerId
    ? and(eq(addresses.customerId, customerId), eq(addresses.type, type), eq(addresses.isActive, true))
    : and(eq(addresses.type, type), eq(addresses.isActive, true));

  return db
    .select({
      id: addresses.id,
      customerId: addresses.customerId,
      type: addresses.type,
      label: addresses.label,
      country: addresses.country,
      attention: addresses.attention,
      addressee: addresses.addressee,
      addrLine1: addresses.addrLine1,
      addrLine2: addresses.addrLine2,
      city: addresses.city,
      state: addresses.state,
      postalCode: addresses.postalCode,
      companyName: addresses.companyName,
      phone: addresses.phone,
    })
    .from(addresses)
    .where(conditions)
    .orderBy(addresses.addressee);
}

export default async function portalAddressRoutes(app: FastifyInstance) {

  // ── Base routes (type in body, defaults to 'shipping') ─────────

  // GET /api/v1/portal/addresses?customerId=5&type=shipping
  app.get<{ Querystring: { customerId?: string; type?: string } }>('/', async (req) => {
    const customerId = req.query.customerId ? parseInt(req.query.customerId) : undefined;
    const type = (req.query.type === 'billing' ? 'billing' : 'shipping') as 'shipping' | 'billing';
    return listAddresses(customerId, type);
  });

  // POST /api/v1/portal/addresses
  // type defaults to 'shipping' if not provided
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateAddressBody.parse(req.body);
    const result = await createAddress(body, body.type);
    return reply.status(201).send(result);
  });

  // ── Shipping Address ───────────────────────────────────────────

  // GET /api/v1/portal/addresses/shipping?customerId=5
  app.get<{ Querystring: { customerId?: string } }>('/shipping', async (req) => {
    const customerId = req.query.customerId ? parseInt(req.query.customerId) : undefined;
    return listAddresses(customerId, 'shipping');
  });

  // POST /api/v1/portal/addresses/shipping
  // Called when user clicks CONFIRM in "New Shipping Address" modal.
  app.post<{ Body: unknown }>('/shipping', async (req, reply) => {
    const body = CreateAddressBody.parse(req.body);
    const result = await createAddress(body, 'shipping');
    return reply.status(201).send(result);
  });

  // ── Billing Address ────────────────────────────────────────────

  // GET /api/v1/portal/addresses/billing?customerId=5
  app.get<{ Querystring: { customerId?: string } }>('/billing', async (req) => {
    const customerId = req.query.customerId ? parseInt(req.query.customerId) : undefined;
    return listAddresses(customerId, 'billing');
  });

  // POST /api/v1/portal/addresses/billing
  // Called when user clicks CONFIRM in "New Billing Address" modal.
  app.post<{ Body: unknown }>('/billing', async (req, reply) => {
    const body = CreateAddressBody.parse(req.body);
    const result = await createAddress(body, 'billing');
    return reply.status(201).send(result);
  });
}
