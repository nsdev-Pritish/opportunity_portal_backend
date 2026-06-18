/**
 * PORTAL — Project Name Routes
 *
 *  POST /api/v1/portal/project-names        → create a new project name (from modal)
 *  GET  /api/v1/portal/project-names        → list all active project names (for dropdown)
 *  GET  /api/v1/portal/project-names/types  → list all active project types (for modal dropdown)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { projectNames, projectTypes } from '../../db/schema/index.js';
import { invalidateDropdown, cacheAside, CacheKeys } from '../../utils/cache.js';
import { ValidationError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import { syncProjectNameToNetsuite } from '../../services/portalNetsuiteSync.service.js';

const CreateProjectNameBody = z.object({
    name: z.string().min(1, 'Project name is required').max(255),
    projectTypeId: z.number({ required_error: 'Project type is required' }).int().positive(),
    description: z.string().max(1000).optional().nullable(),
});

export default async function portalProjectNameRoutes(app: FastifyInstance) {

    // ── GET /api/v1/portal/project-names/types ─────────────────────
    // Returns all active project types — used to populate the Project Type
    // dropdown inside the "Create new project name" modal.
    app.get('/types', async () => {
        return cacheAside(CacheKeys.dropdown('project_types'), env.CACHE_TTL_DROPDOWN, async () => {
            const db = getDb();
            return db
                .select({ id: projectTypes.id, name: projectTypes.name })
                .from(projectTypes)
                .where(eq(projectTypes.isActive, true))
                .orderBy(asc(projectTypes.name));
        });
    });

    // ── GET /api/v1/portal/project-names ───────────────────────────
    // Returns all active project names — used to refresh the Project Name
    // dropdown on the estimate form after a new name is created.
    app.get('/', async () => {
        return cacheAside(CacheKeys.dropdown('project_names'), env.CACHE_TTL_DROPDOWN, async () => {
            const db = getDb();
            return db
                .select({
                    id: projectNames.id,
                    name: projectNames.name,
                    projectTypeId: projectNames.projectTypeId,
                    projectTypeName: projectTypes.name,
                    description: projectNames.description,
                    source: projectNames.source,
                    syncStatus: projectNames.syncStatus,
                })
                .from(projectNames)
                .leftJoin(projectTypes, eq(projectNames.projectTypeId, projectTypes.id))
                .where(eq(projectNames.isActive, true))
                .orderBy(asc(projectNames.name));
        });
    });

    // ── POST /api/v1/portal/project-names ──────────────────────────
    // Called when the user clicks CONFIRM in the "Create new project name" modal.
    // Returns the newly created record so the frontend can immediately add it
    // to the Project Name dropdown and pre-select it.
    app.post<{ Body: unknown }>('/', async (req, reply) => {
        const body = CreateProjectNameBody.parse(req.body);
        const db = getDb();

        const [projectType] = await db
            .select({ id: projectTypes.id, name: projectTypes.name })
            .from(projectTypes)
            .where(eq(projectTypes.id, body.projectTypeId))
            .limit(1);

        if (!projectType) {
            throw new ValidationError(`Project type with id '${body.projectTypeId}' not found.`);
        }

        const [created] = await db
            .insert(projectNames)
            .values({
                name: body.name.trim(),
                projectTypeId: body.projectTypeId,
                description: body.description ?? null,
                source: 'portal',
                syncStatus: 'pending',
            })
            .returning();

        await invalidateDropdown('project_names');

        // Push to NetSuite and store the returned internal id back on the row.
        // Non-throwing: if NS is down/unconfigured the record stays syncStatus='pending'.
        const ns = await syncProjectNameToNetsuite(created.id);
        await invalidateDropdown('project_names');

        return reply.status(201).send({
            ...created,
            netsuiteInternalId: ns.netsuiteInternalId ?? created.netsuiteInternalId,
            syncStatus: ns.syncStatus,
            syncError: ns.syncError,
            projectTypeName: projectType.name,
        });
    });
}

