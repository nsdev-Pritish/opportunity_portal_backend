/**
 * PROJECT NAME APIs
 * Project Names from NetSuite (customrecord_cseg_project)
 * Project Types now depend on Project Names (not vice versa)
 *
 *  POST  /api/v1/netsuite/project-names          → create project name
 *  PUT   /api/v1/netsuite/project-names/:nsId    → update project name
 *  PUT   /api/v1/netsuite/project-names/:nsId/status → activate / deactivate
 *  GET   /api/v1/netsuite/project-names          → list all active project names
 *  GET   /api/v1/netsuite/project-names/:nsId    → get single project name
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { projectNames, projectTypes, customers, subsidiaries } from '../../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

// ─── Validation schemas ───────────────────────────────────────────

const CreateProjectNameSchema = z.object({
  netsuiteInternalId : z.string().min(1),   // NS internalId — required
  projectTypeNsId    : z.string().min(1),   // NS internalId of required project type
  name               : z.string().min(1).max(255),
  customerNsId       : z.string().optional().nullable(),  // NS internalId of customer
  subsidiaryNsId     : z.string().optional().nullable(),  // NS internalId of subsidiary
  description        : z.string().optional().nullable(),
});

const UpdateProjectNameSchema = z.object({
  projectTypeNsId    : z.string().min(1).optional().nullable(),
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
  // Project type is required when creating a project name.
  // If the same netsuiteInternalId already exists → updates it (idempotent).
  //
  // Body:
  //   {
  //     "netsuiteInternalId": "100",
  //     "projectTypeNsId": "200",
  //     "name": "CSEG Project Alpha",
  //     "customerNsId": "300",
  //     "subsidiaryNsId": "400",
  //     "description": "Q1 2026"
  //   }
  //
  // Response: the created/updated project name row
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateProjectNameSchema.parse(req.body);
    const db = getDb();

    const [projectType] = await db
      .select({ id: projectTypes.id })
      .from(projectTypes)
      .where(eq(projectTypes.netsuiteInternalId, body.projectTypeNsId))
      .limit(1);

    if (!projectType) {
      throw new ValidationError(`Project Type with NS id '${body.projectTypeNsId}' not found. Create the project type first.`);
    }

    let customerId: number | null | undefined = undefined;
    if (body.customerNsId !== undefined) {
      if (body.customerNsId) {
        const [customer] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.netsuiteInternalId, body.customerNsId))
          .limit(1);

        if (!customer) {
          throw new ValidationError(`Customer with NS id '${body.customerNsId}' not found.`);
        }
        customerId = customer.id;
      } else {
        customerId = null;
      }
    }

    let subsidiaryId: number | null | undefined = undefined;
    if (body.subsidiaryNsId !== undefined) {
      if (body.subsidiaryNsId) {
        const [subsidiary] = await db
          .select({ id: subsidiaries.id })
          .from(subsidiaries)
          .where(eq(subsidiaries.netsuiteInternalId, body.subsidiaryNsId))
          .limit(1);

        if (!subsidiary) {
          throw new ValidationError(`Subsidiary with NS id '${body.subsidiaryNsId}' not found.`);
        }
        subsidiaryId = subsidiary.id;
      } else {
        subsidiaryId = null;
      }
    }

    const [existing] = await db
      .select({ id: projectNames.id })
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, body.netsuiteInternalId))
      .limit(1);

    if (existing) {
      const updateData: any = {
        name: body.name,
        description: body.description,
        projectTypeId: projectType.id,
        syncStatus: 'synced',
        syncedAt: new Date(),
        updatedAt: new Date(),
      };

      if (body.customerNsId !== undefined) updateData.customerId = customerId;
      if (body.subsidiaryNsId !== undefined) updateData.subsidiaryId = subsidiaryId;

      const [updated] = await db
        .update(projectNames)
        .set(updateData)
        .where(eq(projectNames.id, existing.id))
        .returning();

      await invalidateDropdown('project_names');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const insertData: any = {
      netsuiteInternalId: body.netsuiteInternalId,
      name: body.name,
      projectTypeId: projectType.id,
      description: body.description,
      source: 'netsuite',
      syncStatus: 'synced',
      syncedAt: new Date(),
    };

    if (body.customerNsId !== undefined) insertData.customerId = customerId;
    if (body.subsidiaryNsId !== undefined) insertData.subsidiaryId = subsidiaryId;

    const [created] = await db
      .insert(projectNames)
      .values(insertData)
      .returning();

    await invalidateDropdown('project_names');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/project-names/:nsId ────────────────────────
  // NetSuite updates an existing project name.
  // :nsId = the NS internalId (e.g. "100")
  //
  // Body: any subset of { projectTypeNsId, name, customerNsId, subsidiaryNsId, description }
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateProjectNameSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db
      .select({ id: projectNames.id })
      .from(projectNames)
      .where(eq(projectNames.netsuiteInternalId, req.params.nsId))
      .limit(1);

    if (!existing) throw new NotFoundError('ProjectName', req.params.nsId);

    let customerId: number | null | undefined = undefined;
    if (body.customerNsId !== undefined) {
      if (body.customerNsId) {
        const [customer] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.netsuiteInternalId, body.customerNsId))
          .limit(1);

        if (!customer) {
          throw new ValidationError(`Customer with NS id '${body.customerNsId}' not found.`);
        }
        customerId = customer.id;
      } else {
        customerId = null;
      }
    }

    let subsidiaryId: number | null | undefined = undefined;
    if (body.subsidiaryNsId !== undefined) {
      if (body.subsidiaryNsId) {
        const [subsidiary] = await db
          .select({ id: subsidiaries.id })
          .from(subsidiaries)
          .where(eq(subsidiaries.netsuiteInternalId, body.subsidiaryNsId))
          .limit(1);

        if (!subsidiary) {
          throw new ValidationError(`Subsidiary with NS id '${body.subsidiaryNsId}' not found.`);
        }
        subsidiaryId = subsidiary.id;
      } else {
        subsidiaryId = null;
      }
    }

    let projectTypeId: number | null | undefined = undefined;
    if (body.projectTypeNsId !== undefined) {
      if (body.projectTypeNsId) {
        const [typeRow] = await db
          .select({ id: projectTypes.id })
          .from(projectTypes)
          .where(eq(projectTypes.netsuiteInternalId, body.projectTypeNsId))
          .limit(1);

        if (!typeRow) {
          throw new ValidationError(`Project Type with NS id '${body.projectTypeNsId}' not found.`);
        }

        projectTypeId = typeRow.id;
      } else {
        projectTypeId = null;
      }
    }

    const updateData: any = {
      ...body,
      syncStatus: 'synced',
      syncedAt: new Date(),
      updatedAt: new Date(),
    };
    if (body.projectTypeNsId !== undefined) updateData.projectTypeId = projectTypeId;
    if (body.customerNsId !== undefined) updateData.customerId = customerId;
    if (body.subsidiaryNsId !== undefined) updateData.subsidiaryId = subsidiaryId;
    delete updateData.projectTypeNsId;
    delete updateData.customerNsId;
    delete updateData.subsidiaryNsId;

    const [updated] = await db
      .update(projectNames)
      .set(updateData)
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
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
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
