import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { productDevelopers } from '../db/schema/index.js';
import { AppError } from './errors.js';

/**
 * Reject a portal save that carries an inactive Product Developer.
 *
 * The frontend dropdown lists only active developers, so an inactive one shows as blank — but
 * its id is still sent (e.g. on copy), and NetSuite rejects it. Checked BEFORE anything is
 * written, so nothing is saved here or sent to NetSuite.
 *
 * Only ids that exist AND are inactive are rejected. Nothing is checked when the field
 * wasn't sent or is empty. Not used by the NetSuite inbound routes or the pipeline bulk edit.
 */
export async function assertActiveProductDevelopers(ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const numericIds = ids.filter((v): v is number => typeof v === 'number');
  if (numericIds.length === 0) return;

  const inactive = await getDb()
    .select({ name: productDevelopers.name })
    .from(productDevelopers)
    .where(and(inArray(productDevelopers.id, numericIds), eq(productDevelopers.isActive, false)));

  if (inactive.length > 0) {
    throw new AppError(
      `Product Developer is Inactive: ${inactive.map(r => r.name).join(', ')}. Please select an active Product Developer.`,
      400,
      'INACTIVE_PRODUCT_DEVELOPER',
    );
  }
}
