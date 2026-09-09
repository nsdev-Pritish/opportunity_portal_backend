import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { users } from '../db/schema/index.js';

const DEFAULT_PASSWORD = 'password@123';

export type SyncEmployeeUserInput = {
  netsuiteInternalId: string;
  email: string | null | undefined;
  name: string | null | undefined; // "First Last" — split on first whitespace
  isActive: boolean;
  // NetSuite "EST Portal User" checkbox (custentity_obc_portal_user), mirrored on
  // employees.portalUser. Only the /list/employees feed (src/routes/netsuite/list/
  // employees.ts) passes this — the ACCOUNT_MANAGER/PRODUCT_DEVELOPER feed
  // (src/routes/netsuite/employees.ts) never does, so it's treated as false there,
  // see gate below.
  portalUser?: boolean;
};

// Upserts the Portal login account for a NetSuite-synced employee, keyed solely by
// netsuiteInternalId, so every synced employee gets at most one row. Employees with no
// email are stored with a null email, and two employees may share an email — neither is
// filtered out (users.email is nullable and non-unique, see migration 0091). Such rows
// exist for reporting/identity but cannot log in: the login lookup matches on email, so
// a null email never matches and a duplicated email resolves to an arbitrary row.
// Called from both employee push handlers (src/routes/netsuite/employees.ts and
// src/routes/netsuite/list/employees.ts) after the `employees` row is written.
//
// A brand new row is only created when portalUser && isActive — NetSuite now curates
// who counts as a portal user via that checkbox, so a login should never be minted for
// someone who isn't one. An already-synced row keeps being updated regardless of
// portalUser: NetSuite simply stops sending someone in future /list/employees payloads
// once their checkbox is unchecked, so there's nothing to gate on the update path, and
// the AM/PD feed (which never sends portalUser) must keep being able to refresh a
// legitimate portal user's name/email/status when it touches the same employee.
export async function syncUserForEmployee(input: SyncEmployeeUserInput): Promise<void> {
  const { netsuiteInternalId, isActive, portalUser } = input;
  const email = input.email?.trim().toLowerCase() || null;

  const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean);
  const lastName = rest.join(' ') || undefined;

  const db = getDb();

  const [existing] = await db.select({ id: users.id })
    .from(users).where(eq(users.netsuiteInternalId, netsuiteInternalId)).limit(1);

  if (existing) {
    await db.update(users)
      .set({
        netsuiteInternalId,
        email,
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        isActive,
        // Only the /list/employees feed passes portalUser — leave it untouched when
        // the AM/PD feed (which never sends it) touches this same row.
        ...(portalUser !== undefined ? { portalUser } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    return;
  }

  if (!(portalUser && isActive)) return;

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  await db.insert(users).values({
    email,
    passwordHash,
    firstName: firstName || undefined,
    lastName,
    role: 'user',
    isActive,
    portalUser: true,
    netsuiteInternalId,
    mustChangePassword: true,
  });
}
