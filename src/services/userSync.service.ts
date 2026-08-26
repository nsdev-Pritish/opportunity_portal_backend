import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { users } from '../db/schema/index.js';
import { logger } from '../utils/logger.js';

const DEFAULT_PASSWORD = 'password@123';

export type SyncEmployeeUserInput = {
  netsuiteInternalId: string;
  email: string | null | undefined;
  name: string | null | undefined; // "First Last" — split on first whitespace
  isActive: boolean;
};

// Upserts the Portal login account for a NetSuite-synced employee, keyed by
// netsuiteInternalId (falling back to email so a pre-existing manually-created
// account gets linked instead of hitting the email-unique constraint). Called from
// both employee push handlers (src/routes/netsuite/employees.ts and
// src/routes/netsuite/list/employees.ts) after the `employees` row is written.
export async function syncUserForEmployee(input: SyncEmployeeUserInput): Promise<void> {
  const { netsuiteInternalId, isActive } = input;
  const email = input.email?.trim().toLowerCase() || null;

  if (!email) {
    logger.warn({ netsuiteInternalId }, 'Skipping Portal user sync — employee has no email');
    return;
  }

  const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean);
  const lastName = rest.join(' ') || undefined;

  const db = getDb();

  const [byNsId] = await db.select({ id: users.id })
    .from(users).where(eq(users.netsuiteInternalId, netsuiteInternalId)).limit(1);
  const existing = byNsId ?? (await db.select({ id: users.id })
    .from(users).where(eq(users.email, email)).limit(1))[0];

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
