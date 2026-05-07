/**
 * PROJECT TYPE APIs
 * Project Types belong to a Project Name (parent-child relationship)
 *
 *  GET   /api/v1/netsuite/project-types                     → all active project types
 *  GET   /api/v1/netsuite/project-types?projectNameNsId=100 → filter by project name
 *  GET   /api/v1/netsuite/project-types/:nsId               → single project type
 *  POST  /api/v1/netsuite/project-types                     → create project type
 *  PUT   /api/v1/netsuite/project-types/:nsId               → update project type
 *  PUT   /api/v1/netsuite/project-types/:nsId/status        → activate / deactivate
 *
 * Body for POST/PUT:
 *  { 
 *    "netsuiteInternalId": "40", 
 *    "projectNameNsId": "100",  // NetSuite ID of parent project name
 *    "name": "New Product", 
 *    "description": "New product launch" 
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { projectTypes, projectNames } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  projectNameNsId    : z.string().min(1).optional().nullable(),  // NS internalId of parent project name
  name               : z.string().min(1).max(255),
  description        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function projectTypeRoutes(app: FastifyInstance) {

  // GET /api/v1/netsuite/project-types?projectNameNsId=100
  app.get<{ Querystring: { projectNameNsId?: string } }>('/', async (req) => {
    const db = getDb();
    const { projectNameNsId } = req.query;

    if (projectNameNsId) {
      // Find the project name id first
      const [projName] = await db.select({ id: projectNames.id }).from(projectNames)
        .where(eq(projectNames.netsuiteInternalId, projectNameNsId)).limit(1);
      if (!projName) return [];
      return db.select().from(projectTypes)
        .where(and(eq(projectTypes.projectNameId, projName.id), eq(projectTypes.isActive, true)))
        .orderBy(projectTypes.name);
    }
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

    let projectNameId: number | null = null;
    if (body.projectNameNsId) {
      const [projName] = await db.select({ id: projectNames.id }).from(projectNames)
        .where(eq(projectNames.netsuiteInternalId, body.projectNameNsId)).limit(1);
      if (!projName) {
        throw new ValidationError(`Project Name with NS id '${body.projectNameNsId}' not found. Create the project name first.`);
      }
      projectNameId = projName.id;
    }

    // Idempotency check
    const [existing] = await db.select({ id: projectTypes.id }).from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [updated] = await db.update(projectTypes)
        .set({ 
          projectNameId, 
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
      projectNameId,
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

    let projectNameId: number | null | undefined = undefined;
    if (body.projectNameNsId !== undefined) {
      if (body.projectNameNsId) {
        const [projName] = await db.select({ id: projectNames.id }).from(projectNames)
          .where(eq(projectNames.netsuiteInternalId, body.projectNameNsId)).limit(1);
        if (!projName) {
          throw new ValidationError(`Project Name with NS id '${body.projectNameNsId}' not found.`);
        }
        projectNameId = projName.id;
      } else {
        projectNameId = null;
      }
    }

    const [existing] = await db.select({ id: projectTypes.id }).from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProjectType', req.params.nsId);

    const updateData: any = { 
      ...body, 
      syncStatus: 'synced', 
      syncedAt: new Date(), 
      updatedAt: new Date() 
    };
    if (projectNameId !== undefined) {
      updateData.projectNameId = projectNameId;
    }
    delete updateData.projectNameNsId;

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
