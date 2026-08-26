/**
 * EMPLOYEE (List) APIs
 * Full employee record: identity + role flags + currency / subsidiary / department.
 *
 *  GET   /api/v1/netsuite/list/employees
 *  GET   /api/v1/netsuite/list/employees/:nsId
 *  POST  /api/v1/netsuite/list/employees
 *  PUT   /api/v1/netsuite/list/employees/:nsId
 *  PUT   /api/v1/netsuite/list/employees/:nsId/status   (activate / deactivate)
 *
 * Body for POST/PUT (NetSuite sends NS internal ids for the FK fields; they are
 * resolved to local ids here):
 *  {
 *    "netsuiteInternalId": "5678",
 *    "employeeId": "EMP-001",
 *    "name": "Jane Smith",
 *    "jobTitle": "Account Manager",
 *    "developer": false,
 *    "salesRep": true,
 *    "productDeveloper": false,
 *    "email": "jane@company.com",
 *    "currencyNsId": "1",
 *    "subsidiaryNsId": "5",
 *    "departmentNsId": "12"
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { employees, currencies, subsidiaries, departments } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';
import { syncUserForEmployee } from '../../../services/userSync.service.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  employeeId        : z.string().max(100).optional().nullable(),
  name              : z.string().max(255).optional().nullable(),
  jobTitle          : z.string().max(255).optional().nullable(),
  developer         : z.boolean().optional(),
  salesRep          : z.boolean().optional(),
  productDeveloper  : z.boolean().optional(),
  email             : z.string().max(255).optional().nullable(),
  currencyNsId      : z.string().optional().nullable(),   // NS internalId of currency
  subsidiaryNsId    : z.string().optional().nullable(),   // NS internalId of subsidiary
  departmentNsId    : z.string().optional().nullable(),   // NS internalId of department
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

// Resolve a NetSuite internal id → local table id. Returns null when not found / absent.
async function resolveNsId(table: any, nsId: string | null | undefined): Promise<number | null> {
  if (!nsId) return null;
  const [row] = await getDb().select({ id: table.id }).from(table)
    .where(eq(table.netsuiteInternalId, nsId)).limit(1);
  return row ? row.id : null;
}

export default async function employeeListRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(employees).where(eq(employees.isActive, true)).orderBy(employees.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Employee', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [currencyId, subsidiaryId, departmentId] = await Promise.all([
      resolveNsId(currencies, body.currencyNsId),
      resolveNsId(subsidiaries, body.subsidiaryNsId),
      resolveNsId(departments, body.departmentNsId),
    ]);

    const fields = {
      employeeId      : body.employeeId,
      name            : body.name,
      jobTitle        : body.jobTitle,
      developer       : body.developer ?? false,
      salesRep        : body.salesRep ?? false,
      productDeveloper: body.productDeveloper ?? false,
      email           : body.email,
      currencyId,
      subsidiaryId,
      departmentId,
    };

    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(employees)
        .set({ ...fields, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(employees.id, existing.id)).returning();
      await invalidateDropdown('employees');
      await syncUserForEmployee({
        netsuiteInternalId: upd.netsuiteInternalId!,
        email: upd.email,
        name: upd.name,
        isActive: upd.isActive,
      });
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(employees)
      .values({
        netsuiteInternalId: body.netsuiteInternalId,
        ...fields,
        source: 'netsuite', syncStatus: 'synced', syncedAt: new Date(),
      }).returning();
    await invalidateDropdown('employees');
    await syncUserForEmployee({
      netsuiteInternalId: created.netsuiteInternalId!,
      email: created.email,
      name: created.name,
      isActive: created.isActive,
    });
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Employee', req.params.nsId);

    const updateData: Record<string, unknown> = {
      syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date(),
    };
    if (body.employeeId       !== undefined) updateData.employeeId = body.employeeId;
    if (body.name             !== undefined) updateData.name = body.name;
    if (body.jobTitle         !== undefined) updateData.jobTitle = body.jobTitle;
    if (body.developer        !== undefined) updateData.developer = body.developer;
    if (body.salesRep         !== undefined) updateData.salesRep = body.salesRep;
    if (body.productDeveloper !== undefined) updateData.productDeveloper = body.productDeveloper;
    if (body.email            !== undefined) updateData.email = body.email;
    if (body.currencyNsId     !== undefined) updateData.currencyId = await resolveNsId(currencies, body.currencyNsId);
    if (body.subsidiaryNsId   !== undefined) updateData.subsidiaryId = await resolveNsId(subsidiaries, body.subsidiaryNsId);
    if (body.departmentNsId   !== undefined) updateData.departmentId = await resolveNsId(departments, body.departmentNsId);

    const [updated] = await db.update(employees)
      .set(updateData)
      .where(eq(employees.id, existing.id)).returning();
    await invalidateDropdown('employees');
    await syncUserForEmployee({
      netsuiteInternalId: updated.netsuiteInternalId!,
      email: updated.email,
      name: updated.name,
      isActive: updated.isActive,
    });
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Employee', req.params.nsId);
    const [updated] = await db.update(employees)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(employees.id, existing.id))
      .returning();
    await invalidateDropdown('employees');
    await syncUserForEmployee({
      netsuiteInternalId: updated.netsuiteInternalId!,
      email: updated.email,
      name: updated.name,
      isActive: updated.isActive,
    });
    return { id: updated.id, netsuiteInternalId: updated.netsuiteInternalId, isActive: updated.isActive };
  });
}
