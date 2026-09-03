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
};

// Upserts the Portal login account for a NetSuite-synced employee, keyed solely by
// netsuiteInternalId, so every employee gets exactly one row. Employees with no email
// are stored with a null email, and two employees may share an email — neither is
// filtered out (users.email is nullable and non-unique, see migration 0091). Such rows
// exist for reporting/identity but cannot log in: the login lookup matches on email, so
// a null email never matches and a duplicated email resolves to an arbitrary row.
// Called from both employee push handlers (src/routes/netsuite/employees.ts and
// src/routes/netsuite/list/employees.ts) after the `employees` row is written.
export async function syncUserForEmployee(input: SyncEmployeeUserInput): Promise<void> {
  const { netsuiteInternalId, isActive } = input;
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
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    return;
  }

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);
  await db.insert(users).values({
    email,
    passwordHash,
    firstName: firstName || undefined,
    lastName,
    role: 'user',
    isActive,
    netsuiteInternalId,
    mustChangePassword: true,
  });
}
