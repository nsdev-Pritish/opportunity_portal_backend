/**
 * PROJECT TYPE APIs
 * Project Types are independent master data options.
 *
 *  GET   /api/v1/netsuite/project-types       → all active project types
 *  GET   /api/v1/netsuite/project-types/:nsId → single project type
 *  POST  /api/v1/netsuite/project-types       → create project type
 *  PUT   /api/v1/netsuite/project-types/:nsId → update project type
 *  PUT   /api/v1/netsuite/project-types/:nsId/status → activate / deactivate
 *
 * Body for POST/PUT:
 *  { 
 *    "netsuiteInternalId": "40", 
 *    "name": "New Product", 
 *    "description": "New product launch" 
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { projectTypes } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  description        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function projectTypeRoutes(app: FastifyInstance) {

  // GET /api/v1/netsuite/project-types
  app.get('/', async () => {
    const db = getDb();
    return db.select().from(projectTypes).where(eq(projectTypes.isActive, true)).orderBy(projectTypes.name);
  });

  // GET /api/v1/netsuite/project-types/:nsId
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ProjectType', req.params.nsId);
    return row;
  });

  // POST /api/v1/netsuite/project-types
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: projectTypes.id }).from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [updated] = await db.update(projectTypes)
        .set({ 
          name: body.name, 
          description: body.description, 
          updatedAt: new Date() 
        })
        .where(eq(projectTypes.id, existing.id)).returning();
      await invalidateDropdown('project_types');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const [created] = await db.insert(projectTypes).values({
      netsuiteInternalId : body.netsuiteInternalId,
      name               : body.name,
      description        : body.description,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();

    await invalidateDropdown('project_types');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /api/v1/netsuite/project-types/:nsId
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: projectTypes.id }).from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProjectType', req.params.nsId);

    const updateData: any = { 
      ...body, 
      syncStatus: 'synced', 
      syncedAt: new Date(), 
      updatedAt: new Date() 
    };

    const [updated] = await db.update(projectTypes)
      .set(updateData)
      .where(eq(projectTypes.id, existing.id)).returning();
    await invalidateDropdown('project_types');
    return updated;
  });

  // PUT /api/v1/netsuite/project-types/:nsId/status
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: projectTypes.id }).from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProjectType', req.params.nsId);
    const [updated] = await db.update(projectTypes)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectTypes.id, existing.id))
      .returning({ id: projectTypes.id, netsuiteInternalId: projectTypes.netsuiteInternalId, isActive: projectTypes.isActive });
    await invalidateDropdown('project_types');
    return updated;
  });
}
