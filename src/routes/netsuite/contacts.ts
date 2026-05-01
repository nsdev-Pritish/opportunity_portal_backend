/**
 * CONTACT APIs
 * A contact always belongs to a customer.
 *
 *  POST  /api/v1/netsuite/contacts                       → create contact
 *  PUT   /api/v1/netsuite/contacts/:nsId                 → update contact
 *  PATCH /api/v1/netsuite/contacts/:nsId/status          → activate / deactivate
 *  GET   /api/v1/netsuite/contacts?customerNsId=1234     → list contacts for a customer
 */

import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { contacts, customers } from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateContactSchema = z.object({
  netsuiteInternalId  : z.string().min(1),
  customerNsId        : z.string().min(1),  // NS internalId of the parent customer
  firstName           : z.string().max(100).optional().nullable(),
  lastName            : z.string().max(100).optional().nullable(),
  email               : z.string().email().optional().nullable(),
  phone               : z.string().max(50).optional().nullable(),
  title               : z.string().max(100).optional().nullable(),
});

const UpdateContactSchema = CreateContactSchema.omit({ netsuiteInternalId: true, customerNsId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function contactRoutes(app: FastifyInstance) {

  // GET /api/v1/netsuite/contacts?customerNsId=1234
  app.get<{ Querystring: { customerNsId?: string } }>('/', async (req) => {
    const db = getDb();
    const { customerNsId } = req.query;

    if (customerNsId) {
      // Find the portal customer id first
      const [cust] = await db.select({ id: customers.id }).from(customers)
        .where(eq(customers.netsuiteInternalId, customerNsId)).limit(1);
      if (!cust) return [];
      return db.select().from(contacts)
        .where(and(eq(contacts.customerId, cust.id), eq(contacts.isActive, true)))
        .orderBy(contacts.lastName);
    }
    return db.select().from(contacts).where(eq(contacts.isActive, true)).orderBy(contacts.lastName);
  });

  // POST /api/v1/netsuite/contacts
  // Body: { netsuiteInternalId, customerNsId, firstName, lastName, email, phone, title }
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateContactSchema.parse(req.body);
    const db = getDb();

    // Resolve parent customer
    const [cust] = await db.select({ id: customers.id }).from(customers)
      .where(eq(customers.netsuiteInternalId, body.customerNsId)).limit(1);
    if (!cust) throw new ValidationError(`Customer with NS id '${body.customerNsId}' not found. Create the customer first.`);

    // Idempotency check
    const [existing] = await db.select({ id: contacts.id }).from(contacts)
      .where(eq(contacts.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [updated] = await db.update(contacts)
        .set({ firstName: body.firstName, lastName: body.lastName, email: body.email, phone: body.phone, title: body.title, updatedAt: new Date() })
        .where(eq(contacts.id, existing.id)).returning();
      await invalidateDropdown('contacts');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const [created] = await db.insert(contacts).values({
      netsuiteInternalId : body.netsuiteInternalId,
      customerId         : cust.id,
      firstName          : body.firstName,
      lastName           : body.lastName,
      email              : body.email,
      phone              : body.phone,
      title              : body.title,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();

    await invalidateDropdown('contacts');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /api/v1/netsuite/contacts/:nsId
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateContactSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: contacts.id }).from(contacts)
      .where(eq(contacts.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Contact', req.params.nsId);
    const [updated] = await db.update(contacts)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, existing.id)).returning();
    await invalidateDropdown('contacts');
    return updated;
  });

  // PATCH /api/v1/netsuite/contacts/:nsId/status
  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: contacts.id }).from(contacts)
      .where(eq(contacts.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Contact', req.params.nsId);
    const [updated] = await db.update(contacts)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, existing.id))
      .returning({ id: contacts.id, netsuiteInternalId: contacts.netsuiteInternalId, isActive: contacts.isActive });
    await invalidateDropdown('contacts');
    return updated;
  });
}
