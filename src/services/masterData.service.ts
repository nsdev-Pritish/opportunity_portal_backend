import { eq, ne, asc, and, sql } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { MASTER_TABLES, type MasterEntityKey } from '../db/schema/index.js';
import { cacheAside, invalidateDropdown, CacheKeys } from '../utils/cache.js';
import { env } from '../config/env.js';
import { NotFoundError, ConflictError } from '../utils/errors.js';
import { resolveCountryState, hasGeoFields } from './geo.service.js';

// Turn an address payload's country/state reference into stored columns, dropping the
// NetSuite-only helper keys (countryNsId/stateNsId) that aren't columns on the table.
async function applyAddressGeo(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { countryNsId, stateNsId, ...rest } = data as Record<string, unknown>;
  if (!hasGeoFields(data)) return rest;
  const geo = await resolveCountryState(data as any);
  return { ...rest, countryId: geo.countryId, stateId: geo.stateId, country: geo.country, state: geo.state };
}

export async function listActiveRecords(entity: MasterEntityKey, scopeId?: number) {
  const cacheKey = scopeId ? CacheKeys.dropdownScoped(entity, scopeId) : CacheKeys.dropdown(entity);
  return cacheAside(cacheKey, env.CACHE_TTL_DROPDOWN, async () => {
    const db = getDb();
    const table = MASTER_TABLES[entity] as any;
    const conditions: any[] = [eq(table.isActive, true)];
    // Scope filter — mutually exclusive: a table can have several of these columns
    // (e.g. `addresses` has BOTH customerId and countryId), so pick ONE by precedence.
    // customer > vendor > country matches how the scoped routes pass scopeId.
    if (scopeId) {
      if      ('customerId' in table) conditions.push(eq(table.customerId, scopeId));
      else if ('vendorId'   in table) conditions.push(eq(table.vendorId,   scopeId));
      else if ('countryId'  in table) conditions.push(eq(table.countryId,  scopeId));
    }
    if (entity === 'departments' && 'deptShow' in table) conditions.push(eq(table.deptShow, true));
    
    // Determine sort column based on table structure
    let sortColumn = table.name ?? table.label ?? table.code;
    if (entity === 'contacts') sortColumn = table.lastName;
    if (entity === 'addresses') sortColumn = table.label;
    if (entity === 'cs_items') sortColumn = table.itemName;
    if (entity === 'vendor_addresses') sortColumn = table.addressee ?? table.city ?? table.id;
    sortColumn = sortColumn ?? table.id; // safe fallback for any table without name/label/code

    return db.select().from(table).where(and(...conditions)).orderBy(asc(sortColumn));
  });
}

export async function getAllDropdowns() {
  return cacheAside(CacheKeys.allDropdowns(), env.CACHE_TTL_DROPDOWN, async () => {
    const entities: MasterEntityKey[] = [
      'currencies','project_types','likely_to_close','departments','sales_channels',
      'business_verticals','business_types','hk_partners','ops_partners','compliance_partners',
      'client_incoterms','client_shipping_methods','item_types','product_classes','product_classes_eu',
      'sustainability_options','shipping_groups','factories','vendor_incoterms','cs_items',
      'estimate_statuses','client_pursuit_alternatives','closed_lost_reasons','obc_pod_regions',
      'drayage','countries','states',
    ];
    const result: Record<string, unknown[]> = {};
    await Promise.all(entities.map(async (e) => { result[e] = await listActiveRecords(e); }));
    return result;
  });
}

export async function getRecord(entity: MasterEntityKey, id: number) {
  const db = getDb();
  const table = MASTER_TABLES[entity] as any;
  const [record] = await db.select().from(table).where(eq(table.id, id)).limit(1);
  if (!record) throw new NotFoundError(entity, id);
  return record;
}

export async function createRecord(entity: MasterEntityKey, data: Record<string, unknown>) {
  const db = getDb();
  const table = MASTER_TABLES[entity] as any;
  if (data.netsuiteInternalId) {
    const [ex] = await db.select({ id: table.id }).from(table)
      .where(eq(table.netsuiteInternalId, String(data.netsuiteInternalId))).limit(1);
    if (ex) throw new ConflictError(`${entity} with this NetSuite ID already exists`);
  }
  // Duplicate-name guard for the country/state dropdowns (case-insensitive; a state is
  // unique within its country). Other dropdowns intentionally allow duplicate names.
  if ((entity === 'countries' || entity === 'states') && data.name) {
    const conditions: any[] = [sql`lower(${table.name}) = lower(${String(data.name)})`];
    if (entity === 'states' && data.countryId != null) {
      conditions.push(eq(table.countryId, Number(data.countryId)));
    }
    const [dup] = await db.select({ id: table.id }).from(table)
      .where(and(...conditions)).limit(1);
    if (dup) {
      const label = entity === 'countries' ? 'Country' : 'State';
      throw new ConflictError(`${label} '${data.name}' already exists`);
    }
  }
  // Addresses: resolve country/state ids + names (validates state↔country).
  if (entity === 'addresses') data = await applyAddressGeo(data);
  const [record] = await db.insert(table).values({ ...data, source: 'portal' }).returning();
  await invalidateDropdown(entity);
  return record;
}

export async function updateRecord(entity: MasterEntityKey, id: number, data: Record<string, unknown>) {
  const db = getDb();
  const table = MASTER_TABLES[entity] as any;
  // Duplicate-name guard on rename for the country/state dropdowns — same rule as create,
  // but excluding the row being edited (so a no-op rename to its own name is allowed).
  if ((entity === 'countries' || entity === 'states') && data.name) {
    const conditions: any[] = [
      sql`lower(${table.name}) = lower(${String(data.name)})`,
      ne(table.id, id),
    ];
    if (entity === 'states') {
      let countryId = data.countryId as number | null | undefined;
      if (countryId == null) {
        const [cur] = await db.select({ countryId: table.countryId }).from(table)
          .where(eq(table.id, id)).limit(1);
        countryId = cur?.countryId ?? null;
      }
      if (countryId != null) conditions.push(eq(table.countryId, Number(countryId)));
    }
    const [dup] = await db.select({ id: table.id }).from(table)
      .where(and(...conditions)).limit(1);
    if (dup) {
      const label = entity === 'countries' ? 'Country' : 'State';
      throw new ConflictError(`${label} '${data.name}' already exists`);
    }
  }
  // Addresses: resolve country/state ids + names only when the payload references them
  // (a partial update that omits them must not wipe the existing link).
  if (entity === 'addresses') data = await applyAddressGeo(data);
  const [updated] = await db.update(table).set({ ...data, updatedAt: new Date() })
    .where(eq(table.id, id)).returning();
  if (!updated) throw new NotFoundError(entity, id);
  await invalidateDropdown(entity);
  return updated;
}

export async function setActiveStatus(entity: MasterEntityKey, id: number, isActive: boolean) {
  const db = getDb();
  const table = MASTER_TABLES[entity] as any;
  const [updated] = await db.update(table).set({ isActive, updatedAt: new Date() })
    .where(eq(table.id, id)).returning({ id: table.id, isActive: table.isActive });
  if (!updated) throw new NotFoundError(entity, id);
  await invalidateDropdown(entity);
  return updated;
}
