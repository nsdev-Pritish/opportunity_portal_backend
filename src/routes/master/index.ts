import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listActiveRecords, getRecord, createRecord, updateRecord, setActiveStatus, getAllDropdowns,
} from '../../services/masterData.service.js';
import { type MasterEntityKey, MASTER_TABLES } from '../../db/schema/index.js';
import { ValidationError } from '../../utils/errors.js';

const VALID_ENTITIES = Object.keys(MASTER_TABLES) as MasterEntityKey[];

function assertValidEntity(entity: string): MasterEntityKey {
  if (!VALID_ENTITIES.includes(entity as MasterEntityKey)) {
    throw new ValidationError(`Invalid entity: ${entity}. Valid: ${VALID_ENTITIES.join(', ')}`);
  }
  return entity as MasterEntityKey;
}

export default async function masterRoutes(app: FastifyInstance) {
  // All master routes require auth
  app.addHook('preHandler', app.authenticate);

  // GET /api/v1/master/all-dropdowns — single request for initial page load
  app.get('/all-dropdowns', async () => getAllDropdowns());

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
}
