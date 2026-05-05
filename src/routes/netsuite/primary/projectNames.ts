/**
 * PROJECT NAME APIs
 * Project Names from NetSuite (customrecord_cseg_project)
 * Project Types now depend on Project Names (not vice versa)
 *
 *  POST  /api/v1/netsuite/project-names          → create project name
 *  PUT   /api/v1/netsuite/project-names/:nsId    → update project name
 *  PATCH /api/v1/netsuite/project-names/:nsId/status → activate / deactivate
 *  GET   /api/v1/netsuite/project-names          → list all active project names
 *  GET   /api/v1/netsuite/project-names/:nsId    → get single project name
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { projectNames, customers, subsidiaries } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

// ─── Validation schemas ───────────────────────────────────────────

const CreateProjectNameSchema = z.object({
  netsuiteInternalId : z.string().min(1),   // NS internalId — required
  name               : z.string().min(1).max(255),
  customerNsId       : z.string().optional().nullable(),  // NS internalId of customer
  subsidiaryNsId     : z.string().optional().nullable(),  // NS internalId of subsidiary
  description        : z.string().optional().nullable(),
});

const UpdateProjectNameSchema = z.object({
  name               : z.string().min(1).max(255).optional(),
  customerNsId       : z.string().optional().nullable(),
  subsidiaryNsId     : z.string().optional().nullable(),
  description        : z.string().optional().nullable(),
});

const StatusSchema = z.object({
  isActive : z.boolean(),
});

// ─── Route handler ────────────────────────────────────────────────

export default async function projectNameRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/project-names ──────────────────────────────
  // Returns all active project names.
  // NS uses this to populate the Project Name dropdown.
  app.get('/', async () => {
    const db = getDb();
    return db
      .select()
      .from(projectNames)
      .where(eq(projectNames.isActive, true))
      .orderBy(projectNames.name);
  });

  // ── GET /api/v1/netsuite/project-names/:nsId ────────────────────────
  // Returns a single project name by NS internalId.
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, req.params.nsId))
      .limit(1);
    if (!row) throw new NotFoundError('ProjectName', req.params.nsId);
    return row;
  });

  // ── POST /api/v1/netsuite/project-names ─────────────────────────────
  // NetSuite creates a new project name.
  // If the same netsuiteInternalId already exists → updates it (idempotent).
  //
  // Body:
  //   { "netsuiteInternalId": "100", "name": "CSEG Project Alpha", "description": "Q1 2026" }
  //
  // Response: the created/updated project name row
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateProjectNameSchema.parse(req.body);
    const db = getDb();

    // Idempotency: same NS id already exists → update instead of duplicate
    const [existing] = await db
      .select({ id: projectNames.id })
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, body.netsuiteInternalId))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(projectNames)
        .set({ name: body.name, description: body.description, updatedAt: new Date() })
        .where(eq(projectNames.id, existing.id))
        .returning();
      await invalidateDropdown('project_names');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const [created] = await db
      .insert(projectNames)
      .values({
        netsuiteInternalId : body.netsuiteInternalId,
        name               : body.name,
        description        : body.description,
        source             : 'netsuite',
        syncStatus         : 'synced',
        syncedAt           : new Date(),
      })
      .returning();

    await invalidateDropdown('project_names');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/project-names/:nsId ────────────────────────
  // NetSuite updates an existing project name.
  // :nsId = the NS internalId (e.g. "100")
  //
  // Body: any subset of { name, description }
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateProjectNameSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: projectNames.id })
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, req.params.nsId))
      .limit(1);

    if (!existing) throw new NotFoundError('ProjectName', req.params.nsId);

    const [updated] = await db
      .update(projectNames)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectNames.id, existing.id))
      .returning();

    await invalidateDropdown('project_names');
    return updated;
  });

  // ── PATCH /api/v1/netsuite/project-names/:nsId/status ───────────────
  // Activate or deactivate a project name.
  // Body: { "isActive": false }
  //
  // When isActive=false: project name disappears from dropdowns.
  // Existing project types referencing this project name are NOT affected.
  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: projectNames.id })
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, req.params.nsId))
      .limit(1);

    if (!existing) throw new NotFoundError('ProjectName', req.params.nsId);

    const [updated] = await db
      .update(projectNames)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectNames.id, existing.id))
      .returning({ id: projectNames.id, netsuiteInternalId: projectNames.netsuiteInternalId, isActive: projectNames.isActive });

    await invalidateDropdown('project_names');
    return updated;
  });
}
