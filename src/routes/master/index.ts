import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc } from 'drizzle-orm';
import {
  listActiveRecords, getRecord, createRecord, updateRecord, setActiveStatus, getAllDropdowns,
} from '../../services/masterData.service.js';
import { getAllEstimateQuoteMappings } from '../../services/estimateQuote.service.js';
import { getDb } from '../../config/database.js';
import {type MasterEntityKey, MASTER_TABLES, esStatus, classes, drayage,
  creativeRequestTypes, creativeRequestCategories, newClients, creativeRequestAssets,
  creativeRequestScopeWork, aboutUsInfo, requestors, divisionalBudgets,
} from '../../db/schema/index.js';
import { ValidationError } from '../../utils/errors.js';

const VALID_ENTITIES = Object.keys(MASTER_TABLES) as MasterEntityKey[];

function assertValidEntity(entity: string): MasterEntityKey {
  if (!VALID_ENTITIES.includes(entity as MasterEntityKey)) {
    throw new ValidationError(`Invalid entity: ${entity}. Valid: ${VALID_ENTITIES.join(', ')}`);
  }
  return entity as MasterEntityKey;
}

export default async function masterRoutes(app: FastifyInstance) {
  // All master ro  // ⚠️ TEMPORARY: Authentication disabled for development
  // TODO: Re-enable authentication when frontend implements login
  // app.addHook('preHandler', app.authenticate);

  // 🐛 DEBUG ENDPOINTS (Remove in production)
  app.get('/debug/clear-cache', async () => {
    const { getRedis } = await import('../../config/redis.js');
    const redis = getRedis();
    await redis.flushdb();
    return { message: 'Cache cleared successfully' };
  });

  app.get('/debug/:entity/raw', async (req: any) => {
    const entity = assertValidEntity(req.params.entity);
    const { getDb } = await import('../../config/database.js');
    const db = getDb();
    const table = MASTER_TABLES[entity] as any;
    const records = await db.select().from(table).limit(100);
    return {
      entity,
      count: records.length,
      records,
      note: 'This shows ALL records regardless of isActive status'
    };
  });
  app.get('/all-dropdowns', async () => getAllDropdowns());

  // GET /api/v1/master/es-status — ALL es_status rows (active + inactive)
  app.get('/es-status', async () =>
    getDb().select().from(esStatus).orderBy(asc(esStatus.name)),
  );

  // GET /api/v1/master/classes — ALL class rows (active + inactive), all fields
  app.get('/classes', async () =>
    getDb().select().from(classes).orderBy(asc(classes.name)),
  );

  // GET /api/v1/master/drayage — ALL drayage rows (active + inactive), all fields
  app.get('/drayage', async () =>
    getDb().select().from(drayage).orderBy(asc(drayage.name)),
  );

  // GET /api/v1/master/estimate-quotes — all Estimate ↔ Quote mappings
  app.get('/estimate-quotes', async () => getAllEstimateQuoteMappings());

  // ── Wrike request lists — ALL rows (active + inactive), for the admin screens.
  // The active-only dropdown feeds are served by the generic GET /:entity below.
  app.get('/creative-request-types', async () =>
    getDb().select().from(creativeRequestTypes).orderBy(asc(creativeRequestTypes.name)),
  );

  app.get('/creative-request-categories', async () =>
    getDb().select().from(creativeRequestCategories).orderBy(asc(creativeRequestCategories.name)),
  );

  app.get('/new-clients', async () =>
    getDb().select().from(newClients).orderBy(asc(newClients.name)),
  );

  app.get('/creative-request-assets', async () =>
    getDb().select().from(creativeRequestAssets).orderBy(asc(creativeRequestAssets.name)),
  );

  app.get('/creative-request-scope-work', async () =>
    getDb().select().from(creativeRequestScopeWork).orderBy(asc(creativeRequestScopeWork.name)),
  );

  app.get('/about-us-info', async () =>
    getDb().select().from(aboutUsInfo).orderBy(asc(aboutUsInfo.name)),
  );

  app.get('/requestors', async () =>
    getDb().select().from(requestors).orderBy(asc(requestors.name)),
  );

  // GET /api/v1/master/divisional-budgets — ALL rows (active + inactive), for the admin screen.
  // The active-only dropdown feed is served by the generic GET /:entity below.
  app.get('/divisional-budgets', async () =>
    getDb().select().from(divisionalBudgets).orderBy(asc(divisionalBudgets.name)),
  );

  // GET /api/v1/master/:entity — list active (dropdown)
  app.get<{ Params: { entity: string }; Querystring: { scopeId?: string } }>(
    '/:entity',
    async (req) => {
      const entity = assertValidEntity(req.params.entity);
      const scopeId = req.query.scopeId ? parseInt(req.query.scopeId) : undefined;
      return listActiveRecords(entity, scopeId);
    },
  );

  // GET /api/v1/master/:entity/:id — single record
  app.get<{ Params: { entity: string; id: string } }>(
    '/:entity/:id',
    async (req) => {
      const entity = assertValidEntity(req.params.entity);
      return getRecord(entity, parseInt(req.params.id));
    },
  );

  // POST /api/v1/master/:entity — create
  app.post<{ Params: { entity: string }; Body: Record<string, unknown> }>(
    '/:entity',
    async (req, reply) => {
      const entity = assertValidEntity(req.params.entity);
      const record = await createRecord(entity, req.body);
      return reply.status(201).send(record);
    },
  );

  // PATCH /api/v1/master/:entity/:id — edit
  app.patch<{ Params: { entity: string; id: string }; Body: Record<string, unknown> }>(
    '/:entity/:id',
    async (req) => {
      const entity = assertValidEntity(req.params.entity);
      return updateRecord(entity, parseInt(req.params.id), req.body);
    },
  );

  // PATCH /api/v1/master/:entity/:id/status — activate / deactivate
  app.patch<{
    Params: { entity: string; id: string };
    Body: { is_active: boolean };
  }>(
    '/:entity/:id/status',
    async (req) => {
      const entity = assertValidEntity(req.params.entity);
      const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
      return setActiveStatus(entity, parseInt(req.params.id), is_active);
    },
  );

  // Scoped lookups: GET /api/v1/master/customers/:id/contacts
  app.get<{ Params: { customerId: string } }>(
    '/customers/:customerId/contacts',
    async (req) => listActiveRecords('contacts', parseInt(req.params.customerId)),
  );

  app.get<{ Params: { customerId: string } }>(
    '/customers/:customerId/addresses',
    async (req) => listActiveRecords('addresses', parseInt(req.params.customerId)),
  );

  app.get<{ Params: { vendorId: string } }>(
    '/vendors/:vendorId/factories',
    async (req) => listActiveRecords('factories', parseInt(req.params.vendorId)),
  );

  app.get<{ Params: { vendorId: string } }>(
    '/vendors/:vendorId/addresses',
    async (req) => listActiveRecords('vendor_addresses', parseInt(req.params.vendorId)),
  );

  // Scoped lookup: GET /api/v1/master/countries/:countryId/states — states of a country
  app.get<{ Params: { countryId: string } }>(
    '/countries/:countryId/states',
    async (req) => listActiveRecords('states', parseInt(req.params.countryId)),
  );
}
