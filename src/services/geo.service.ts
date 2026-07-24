/**
 * Shared country/state resolution used by every address-writing path
 * (portal create/update, NetSuite address sync, generic master create/update).
 *
 * Turns any country/state reference into a consistent
 *   { countryId, stateId, country, state }
 * quad — where `country`/`state` are the canonical master names (for the free-text
 * columns the NetSuite sync reads) and `countryId`/`stateId` are the FK links.
 *
 * A reference can arrive as:
 *   - local ids      : countryId / stateId          (portal UI)
 *   - NetSuite ids   : countryNsId / stateNsId       (NetSuite sync)
 *   - free text      : country / state (name or code) (best-effort link, kept if unmatched)
 *
 * Rules:
 *   - An explicit (unknown) local id throws ValidationError.
 *   - A state that belongs to a different country than the one selected throws ValidationError.
 *   - When only the state is known, the country is backfilled from it.
 *   - Free-text that matches no master row leaves the id null and keeps the text as-is.
 */

import { eq, and, or, sql } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { countries, states } from '../db/schema/index.js';
import { ValidationError } from '../utils/errors.js';

export interface GeoInput {
  countryId?: number | null;
  stateId?: number | null;
  countryNsId?: string | null;
  stateNsId?: string | null;
  country?: string | null;   // free-text name or code
  state?: string | null;     // free-text name or code
}

export interface GeoResolved {
  countryId: number | null;
  stateId: number | null;
  country: string | null;
  state: string | null;
}

/** True when the payload carries any country/state reference worth resolving. */
export function hasGeoFields(data: Record<string, unknown>): boolean {
  return ['countryId', 'stateId', 'countryNsId', 'stateNsId', 'country', 'state']
    .some((k) => k in data && data[k] != null);
}

export async function resolveCountryState(input: GeoInput): Promise<GeoResolved> {
  const db = getDb();
  let countryId = input.countryId ?? null;
  let stateId   = input.stateId ?? null;
  let country   = input.country ?? null;
  let state     = input.state ?? null;

  // ── Country ──────────────────────────────────────────────────────────
  // 1) by NetSuite internal id
  if (countryId == null && input.countryNsId) {
    const [c] = await db.select({ id: countries.id }).from(countries)
      .where(eq(countries.netsuiteInternalId, input.countryNsId)).limit(1);
    if (c) countryId = c.id;
  }
  // 2) by free-text code or name (best-effort — leaves id null if no match)
  if (countryId == null && country) {
    const [c] = await db.select({ id: countries.id }).from(countries)
      .where(or(
        sql`lower(${countries.code}) = lower(${country})`,
        sql`lower(${countries.name}) = lower(${country})`,
      )).limit(1);
    if (c) countryId = c.id;
  }
  // 3) validate an explicit id and adopt its canonical name
  if (countryId != null) {
    const [c] = await db.select({ name: countries.name }).from(countries)
      .where(eq(countries.id, countryId)).limit(1);
    if (!c) throw new ValidationError(`Country with id '${countryId}' not found.`);
    country = c.name;
  }

  // ── State ────────────────────────────────────────────────────────────
  // 1) by NetSuite internal id
  if (stateId == null && input.stateNsId) {
    const [s] = await db.select({ id: states.id }).from(states)
      .where(eq(states.netsuiteInternalId, input.stateNsId)).limit(1);
    if (s) stateId = s.id;
  }
  // 2) by free-text code or name, scoped to the country when known
  if (stateId == null && state) {
    const conds: any[] = [or(
      sql`lower(${states.code}) = lower(${state})`,
      sql`lower(${states.name}) = lower(${state})`,
    )];
    if (countryId != null) conds.push(eq(states.countryId, countryId));
    const [s] = await db.select({ id: states.id }).from(states).where(and(...conds)).limit(1);
    if (s) stateId = s.id;
  }
  // 3) validate an explicit id, enforce it belongs to the country, backfill country
  if (stateId != null) {
    const [s] = await db.select({ name: states.name, countryId: states.countryId }).from(states)
      .where(eq(states.id, stateId)).limit(1);
    if (!s) throw new ValidationError(`State with id '${stateId}' not found.`);
    if (countryId != null && s.countryId != null && s.countryId !== countryId) {
      throw new ValidationError(`State '${s.name}' does not belong to the selected country.`);
    }
    state = s.name;
    if (countryId == null && s.countryId != null) {
      countryId = s.countryId;
      const [c] = await db.select({ name: countries.name }).from(countries)
        .where(eq(countries.id, s.countryId)).limit(1);
      if (c) country = c.name;
    }
  }

  return { countryId, stateId, country, state };
}
