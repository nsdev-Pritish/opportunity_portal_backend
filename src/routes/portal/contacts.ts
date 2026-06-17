/**
 * PORTAL — Contact Routes
 *
 *  POST /api/v1/portal/contacts   → create a new contact (from modal)
 *  GET  /api/v1/portal/contacts   → list contacts for a customer (?customerId=5)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { contacts, customers } from '../../db/schema/index.js';
import { invalidateDropdown } from '../../utils/cache.js';
import { ValidationError } from '../../utils/errors.js';

const CreateContactBody = z.object({
  customerId: z.number({ required_error: 'Customer is required' }).int().positive(),
  firstName: z.string().min(1, 'Contact name is required').max(100),
  lastName: z.string().max(100).optional().nullable(),
  email: z.string().email('Invalid email').max(255).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  title: z.string().max(100).optional().nullable(),
});

export default async function portalContactRoutes(app: FastifyInstance) {

  // GET /api/v1/portal/contacts?customerId=5
  // Returns all active contacts for a customer — refreshes the Customer Contact dropdown.
  app.get<{ Querystring: { customerId?: string } }>('/', async (req) => {
    const db = getDb();
    const customerId = req.query.customerId ? parseInt(req.query.customerId) : undefined;

    if (customerId) {
      return db
        .select({
          id: contacts.id,
          customerId: contacts.customerId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          title: contacts.title,
        })
        .from(contacts)
        .where(and(eq(contacts.customerId, customerId), eq(contacts.isActive, true)))
        .orderBy(contacts.lastName);
    }

    return db
      .select({
        id: contacts.id,
        customerId: contacts.customerId,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        title: contacts.title,
      })
      .from(contacts)
      .where(eq(contacts.isActive, true))
      .orderBy(contacts.lastName);
  });

  // POST /api/v1/portal/contacts
  // Called when the user clicks CONFIRM in the "Create new contact" modal.
  // Returns the created record so the frontend can immediately pre-select it.
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateContactBody.parse(req.body);
    const db = getDb();

    // Validate customer exists
    const [customer] = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.id, body.customerId))
      .limit(1);

    if (!customer) {
      throw new ValidationError(`Customer with id '${body.customerId}' not found.`);
    }

    const [created] = await db
      .insert(contacts)
      .values({
        customerId: body.customerId,
        firstName: body.firstName.trim(),
        lastName: body.lastName?.trim() ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        title: body.title ?? null,
        source: 'portal',
        syncStatus: 'pending',
      })
      .returning();

    await invalidateDropdown('contacts');

    return reply.status(201).send({
      ...created,
      customerName: customer.name,
    });
  });
}
