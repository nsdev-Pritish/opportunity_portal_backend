/**
 * ADDITIONAL FEES APIs
 *
 *  GET   /api/v1/netsuite/freight-cost/additional-fees
 *  GET   /api/v1/netsuite/freight-cost/additional-fees/:nsId
 *  POST  /api/v1/netsuite/freight-cost/additional-fees
 *  PUT   /api/v1/netsuite/freight-cost/additional-fees/:nsId
 *  PUT   /api/v1/netsuite/freight-cost/additional-fees/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "401",
 *   "name": "FEES-LCL-US",
 *   "freightType": "LCL",
 *   "docFee": "75.00",
 *   "amsFee": "35.00",
 *   "deConsolFee": "50.00",
 *   "ddsisFee": "45.00",
 *   "fceFee": "60.00",
 *   "pierPass": "25.00",
 *   "handlingFee": "80.00",
 *   "isfFiling": "55.00",
 *   "entryFee": "120.00",
 *   "palletSurcharge": "30.00",
 *   "carrierImportFee": "40.00",
 *   "addFeeTotal": "615.00"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { additionalFees } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  freightType        : z.string().max(100).optional().nullable(),
  docFee             : z.string().optional().nullable(),
  amsFee             : z.string().optional().nullable(),
  deConsolFee        : z.string().optional().nullable(),
  ddsisFee           : z.string().optional().nullable(),
  fceFee             : z.string().optional().nullable(),
  pierPass           : z.string().optional().nullable(),
  handlingFee        : z.string().optional().nullable(),
  isfFiling          : z.string().optional().nullable(),
  entryFee           : z.string().optional().nullable(),
  palletSurcharge    : z.string().optional().nullable(),
  carrierImportFee   : z.string().optional().nullable(),
  addFeeTotal        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function additionalFeeRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(additionalFees).where(eq(additionalFees.isActive, true)).orderBy(additionalFees.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(additionalFees)
      .where(eq(additionalFees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('AdditionalFee', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: additionalFees.id }).from(additionalFees)
      .where(eq(additionalFees.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(additionalFees)
        .set({
          name             : body.name,
          freightType      : body.freightType ?? null,
          docFee           : body.docFee ?? null,
          amsFee           : body.amsFee ?? null,
          deConsolFee      : body.deConsolFee ?? null,
          ddsisFee         : body.ddsisFee ?? null,
          fceFee           : body.fceFee ?? null,
          pierPass         : body.pierPass ?? null,
          handlingFee      : body.handlingFee ?? null,
          isfFiling        : body.isfFiling ?? null,
          entryFee         : body.entryFee ?? null,
          palletSurcharge  : body.palletSurcharge ?? null,
          carrierImportFee : body.carrierImportFee ?? null,
          addFeeTotal      : body.addFeeTotal ?? null,
          syncStatus       : 'synced',
          syncedAt         : new Date(),
          updatedAt        : new Date(),
        })
        .where(eq(additionalFees.id, existing.id)).returning();
      await invalidateDropdown('additional_fees');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(additionalFees).values({
      netsuiteInternalId : body.netsuiteInternalId,
      name               : body.name,
      freightType        : body.freightType ?? null,
      docFee             : body.docFee ?? null,
      amsFee             : body.amsFee ?? null,
      deConsolFee        : body.deConsolFee ?? null,
      ddsisFee           : body.ddsisFee ?? null,
      fceFee             : body.fceFee ?? null,
      pierPass           : body.pierPass ?? null,
      handlingFee        : body.handlingFee ?? null,
      isfFiling          : body.isfFiling ?? null,
      entryFee           : body.entryFee ?? null,
      palletSurcharge    : body.palletSurcharge ?? null,
      carrierImportFee   : body.carrierImportFee ?? null,
      addFeeTotal        : body.addFeeTotal ?? null,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();
    await invalidateDropdown('additional_fees');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: additionalFees.id }).from(additionalFees)
      .where(eq(additionalFees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AdditionalFee', req.params.nsId);
    const [updated] = await db.update(additionalFees)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(additionalFees.id, existing.id)).returning();
    await invalidateDropdown('additional_fees');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: additionalFees.id }).from(additionalFees)
      .where(eq(additionalFees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AdditionalFee', req.params.nsId);
    const [updated] = await db.update(additionalFees)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(additionalFees.id, existing.id))
      .returning({ id: additionalFees.id, netsuiteInternalId: additionalFees.netsuiteInternalId, isActive: additionalFees.isActive });
    await invalidateDropdown('additional_fees');
    return updated;
  });
}
