import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// PostgreSQL codes meaning "object already exists or is not applicable" — safe to skip
const ALREADY_EXISTS = new Set([
  '42P07', // relation already exists
  '42701', // column already exists
  '42710', // constraint already exists
  '42P06', // schema already exists
  '42P16', // index already exists
  '42703', // undefined_column — FK references a column that no longer exists in the schema
  '42P01', // undefined_table — referenced table was dropped/renamed
]);

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set in .env');
    process.exit(1);
  }

  console.log('Connecting to database...');

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 60, // handles Render.com cold starts
    idle_timeout: 30,
    prepare: false,
  });

  try {
    // Own tracking table — independent of drizzle-kit
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         serial PRIMARY KEY,
        name       text NOT NULL UNIQUE,
        applied_at timestamptz DEFAULT now() NOT NULL
      )
    `);

    const applied = await sql`SELECT name FROM schema_migrations`;
    const appliedSet = new Set(applied.map((r: any) => r.name));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort(); // alphabetical = chronological for drizzle naming

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        skippedCount++;
        continue;
      }

      const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

      const statements = content
        .split('--> statement-breakpoint')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !/^--/.test(s));

      if (statements.length === 0) {
        await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
        console.log(`  ✓  ${file} (empty)`);
        appliedCount++;
        continue;
      }

      console.log(`  ▶  ${file} — ${statements.length} statement(s)`);

      for (const stmt of statements) {
        try {
          await sql.unsafe(stmt);
        } catch (err: any) {
          if (ALREADY_EXISTS.has(err.code)) {
            // Already applied via db:push — skip silently
            console.log(`     ⚠  skipped (already exists): ${err.message}`);
          } else {
            throw new Error(`Failed in ${file}:\n${err.message}\n\nStatement:\n${stmt.substring(0, 400)}`);
          }
        }
      }

      await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
      console.log(`  ✓  ${file}`);
      appliedCount++;
    }

    if (appliedCount === 0) {
      console.log(`\nDatabase is up to date. (${skippedCount} already applied)`);
    } else {
      console.log(`\nDone. ${appliedCount} applied, ${skippedCount} already up to date.`);
    }
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exit(1);
  } finally {
    await sql.end();
    console.log('Connection closed.');
  }
}

runMigrations();
