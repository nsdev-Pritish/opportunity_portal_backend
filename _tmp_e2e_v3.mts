/**
 * In-depth E2E v3 for POST /api/v1/netsuite/estimate-quotes/sync-all
 * v2 scenarios (test-pattern bug in #19 fixed) + harder concurrency probes.
 */
import { eq, inArray, sql as raw } from 'drizzle-orm';
import { getDb, closeDb } from './src/config/database.js';
import { estimates, estimateQuotes, estimateLineItems, customers } from './src/db/schema/index.js';

const BASE = 'http://localhost:3000/api/v1/netsuite/estimate-quotes';
const db = getDb();

let pass = 0, fail = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; results.push(`PASS | ${name}`); }
  else { fail++; results.push(`FAIL | ${name}${detail ? ' → ' + detail : ''}`); }
}
const count = async () => (await db.select({ c: raw<number>`count(*)::int` }).from(estimateQuotes))[0].c;
const rowsFor = (nsId: string) => db.select().from(estimateQuotes).where(eq(estimateQuotes.quoteNetsuiteInternalId, nsId));
const countLike = async (pat: string) => (await db.select({ c: raw<number>`count(*)::int` }).from(estimateQuotes).where(raw`quote_netsuite_internal_id LIKE ${pat}`))[0].c;

async function post(body: unknown, qs = '') {
  const res = await fetch(`${BASE}/sync-all${qs}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': 'test' } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
const TST = ['TST-EST-1', 'TST-EST-2', 'TST-EST-3', 'TST-EST-4'];
const stale = await db.delete(estimates).where(inArray(estimates.netsuiteInternalId, TST)).returning({ id: estimates.id });
if (stale.length) console.log(`cleaned ${stale.length} leftover test estimate(s)`);
const [cust] = await db.select({ id: customers.id }).from(customers).limit(1);
const baseline = await count();
console.log(`baseline: ${baseline} quote rows, customer ${cust.id}\n`);

const mk = async (ns: string, doc: string, name: string) =>
  (await db.insert(estimates).values({ netsuiteInternalId: ns, documentNumber: doc, customerId: cust.id, projectName: name, status: 'draft' }).returning({ id: estimates.id }))[0];
const E1 = await mk('TST-EST-1', 'TST-DOC-1', 'TEST E1');
const E2 = await mk('TST-EST-2', 'TST-DOC-2', 'TEST E2');
const E3 = await mk('TST-EST-3', 'TST-DOC-3', 'TEST E3');
const E4 = await mk('TST-EST-4', 'TST-DOC-4', 'TEST E4');
await db.insert(estimateLineItems).values([
  { estimateId: E1.id, lineNumber: 1, netsuiteInternalId: 'TST-LI-1' },
  { estimateId: E1.id, lineNumber: 2, netsuiteInternalId: 'TST-LI-2' },
  { estimateId: E1.id, lineNumber: 3, netsuiteInternalId: 'TST-LI-3' },
  { estimateId: E2.id, lineNumber: 1, netsuiteInternalId: 'TST-LI-E2' },
]);
const [stub] = await db.insert(estimateQuotes).values({
  estimateId: E3.id, quoteNetsuiteInternalId: null, quoteDocumentNumber: 'TST-Q-ADOPT',
  status: 'active', syncStatus: 'failed', syncError: 'ns write-back failed',
}).returning({ id: estimateQuotes.id });
console.log(`estimates ${E1.id}/${E2.id}/${E3.id}/${E4.id}, stub ${stub.id}\n`);

// ═══ 1 DRY RUN ════════════════════════════════════════════════════════════════
{
  const before = await count();
  const r = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-DRY', quoteDocumentNumber: 'TST-QD-DRY' }], '?dryRun=true');
  check('1 dryRun 201 + would_create', r.status === 201 && r.body.succeeded[0].action === 'would_create');
  check('1 dryRun flag echoed', r.body.dryRun === true);
  check('1 dryRun writes nothing', before === await count());
  check('1 dryRun=1 variant honoured', (await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-DRY2' }], '?dryRun=1')).body.dryRun === true);
}
// ═══ 2 CREATE ═════════════════════════════════════════════════════════════════
{
  const r = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-1', quoteDocumentNumber: 'TST-QD-1', status: 'active', lineItemInternalIds: ['TST-LI-1', 'TST-LI-2'] }]);
  const s = r.body.succeeded?.[0];
  check('2 create 201 + created', r.status === 201 && s?.action === 'created');
  check('2 resolved by NS id', s?.estimateId === E1.id);
  check('2 updatedLineItems = 2', s?.updatedLineItems === 2);
  check('2 lineItemsMarkedConverted = 2', r.body.lineItemsMarkedConverted === 2);
  const m = Object.fromEntries((await db.select({ ns: estimateLineItems.netsuiteInternalId, c: estimateLineItems.converted }).from(estimateLineItems).where(eq(estimateLineItems.estimateId, E1.id))).map(x => [x.ns, x.c]));
  check('2 only named lines converted', m['TST-LI-1'] === true && m['TST-LI-2'] === true && m['TST-LI-3'] === false);
  const [q] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, s.quoteId));
  check('2 synced + syncedAt set', q.syncStatus === 'synced' && q.syncedAt !== null);
  check('2 docNumber + status stored', q.quoteDocumentNumber === 'TST-QD-1' && q.status === 'active');
}
// ═══ 3 IDEMPOTENCY ════════════════════════════════════════════════════════════
{
  const before = await count();
  const [prev] = await rowsFor('TST-Q-1');
  await new Promise(r => setTimeout(r, 1100));
  const r = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-1', quoteDocumentNumber: 'TST-QD-1' }]);
  const [now] = await rowsFor('TST-Q-1');
  check('3 re-run → updated', r.body.succeeded?.[0]?.action === 'updated');
  check('3 created 0 / updated 1', r.body.created === 0 && r.body.updated === 1);
  check('3 no duplicate row', before === await count());
  check('3 syncedAt refreshed', new Date(now.syncedAt!).getTime() > new Date(prev.syncedAt!).getTime());
  check('3 same row id kept', now.id === prev.id);
  check('3 converted lines stay converted', (await db.select({ c: estimateLineItems.converted }).from(estimateLineItems).where(inArray(estimateLineItems.netsuiteInternalId, ['TST-LI-1', 'TST-LI-2']))).every(l => l.c === true));
}
// ═══ 4 DOC-NUMBER FALLBACK ════════════════════════════════════════════════════
check('4 doc-number fallback resolves E2', (await post([{ estimateDocumentNumber: 'TST-DOC-2', quoteInternalId: 'TST-Q-2', quoteDocumentNumber: 'TST-QD-2' }])).body.succeeded?.[0]?.estimateId === E2.id);

// ═══ 5 ADOPT ORPHAN ═══════════════════════════════════════════════════════════
{
  const before = await count();
  const r = await post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-3', quoteDocumentNumber: 'TST-Q-ADOPT' }]);
  const s = r.body.succeeded?.[0];
  const [row] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, stub.id));
  check('5 action adopted', s?.action === 'adopted', JSON.stringify(s));
  check('5 reused stub row', s?.quoteId === stub.id);
  check('5 no new row', before === await count());
  check('5 NS id attached', row.quoteNetsuiteInternalId === 'TST-Q-3');
  check('5 failed→synced, error cleared', row.syncStatus === 'synced' && row.syncError === null);
}
// ═══ 6 PARTIAL BATCH ══════════════════════════════════════════════════════════
{
  const r = await post([{ estimateInternalId: 'TST-NOPE', quoteInternalId: 'TST-Q-BAD' }, { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-4', quoteDocumentNumber: 'TST-QD-4' }]);
  check('6 → 207', r.status === 207, `${r.status}`);
  check('6 counts 1/1', r.body.failureCount === 1 && r.body.successCount === 1);
  check('6 ESTIMATE_NOT_FOUND/404', r.body.failed[0].code === 'ESTIMATE_NOT_FOUND' && r.body.failed[0].statusCode === 404);
  check('6 failed index preserved', r.body.failed[0].index === 0);
  check('6 good record committed', (await rowsFor('TST-Q-4')).length === 1);
  check('6 bad record wrote nothing', (await rowsFor('TST-Q-BAD')).length === 0);
}
// ═══ 7 DUP IN PAYLOAD ═════════════════════════════════════════════════════════
{
  const r = await post([
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-DUP', quoteDocumentNumber: 'TST-QD-DUP' },
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-DUP', quoteDocumentNumber: 'TST-QD-DUP-REV' },
  ]);
  const rows = await rowsFor('TST-Q-DUP');
  check('7 created 1 + updated 1', r.body.created === 1 && r.body.updated === 1);
  check('7 exactly one row', rows.length === 1, `${rows.length}`);
  check('7 last value wins', rows[0]?.quoteDocumentNumber === 'TST-QD-DUP-REV');
}
// ═══ 8 LOOSE TYPING ═══════════════════════════════════════════════════════════
{
  const r = await post([
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 987654321, quoteDocumentNumber: 555 },
    { estimateInternalId: { value: 'TST-EST-1', text: 'x' }, quoteInternalId: { value: 'TST-Q-OBJ' }, quoteDocumentNumber: 'TST-QD-OBJ', lineItemInternalIds: ['TST-LI-3'] },
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-NUMLI', lineItemInternalIds: [123, 'TST-LI-3'] },
  ]);
  check('8 numeric quote id → string', r.body.succeeded?.[0]?.quoteInternalId === '987654321');
  check('8 numeric docNumber → string', r.body.succeeded?.[0]?.quoteDocumentNumber === '555');
  check('8 {value,text} unwrapped', r.body.succeeded?.[1]?.quoteInternalId === 'TST-Q-OBJ' && r.body.succeeded?.[1]?.estimateId === E1.id);
  check('8 numeric line ids coerced', r.body.succeeded?.[2]?.updatedLineItems === 1);
  const nul = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-NULLS', quoteDocumentNumber: null, status: null, lineItemInternalIds: [] }]);
  check('8 explicit nulls accepted as absent', nul.status === 201, `${nul.status} (500 = app.ts error-handler ordering)`);
  check('8 empty strings accepted as absent', (await post([{ estimateInternalId: 'TST-EST-1', estimateDocumentNumber: '', quoteInternalId: 'TST-Q-BLANK', quoteDocumentNumber: '' }])).status === 201);
}
// ═══ 9 BODY SHAPES ════════════════════════════════════════════════════════════
{
  check('9 single object', (await post({ estimateInternalId: 'TST-EST-2', quoteInternalId: 'TST-Q-SINGLE', quoteDocumentNumber: 'TST-QD-S' })).body.total === 1);
  for (const key of ['quotes', 'records', 'data']) {
    const r = await post({ [key]: [{ estimateInternalId: 'TST-EST-2', quoteInternalId: `TST-Q-${key}` }] });
    check(`9 { ${key}: [...] }`, r.status === 201 && r.body.total === 1);
  }
}
// ═══ 10 STATUS ════════════════════════════════════════════════════════════════
{
  const ok = await post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-REPL', quoteDocumentNumber: 'TST-QD-REPL', status: 'replaced' }]);
  check('10 replaced persisted', ok.status === 201 && (await rowsFor('TST-Q-REPL'))[0]?.status === 'replaced');
  await post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-REPL', status: 'active' }]);
  check('10 flips back to active', (await rowsFor('TST-Q-REPL'))[0]?.status === 'active');
  const bad = await post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-BADSTAT', status: 'nonsense' }]);
  check('10 invalid status rejected (no write)', (await rowsFor('TST-Q-BADSTAT')).length === 0);
  check('10 invalid status → 400', bad.status === 400, `${bad.status} (500 = app.ts error-handler ordering)`);
}
// ═══ 11 VALIDATION ════════════════════════════════════════════════════════════
{
  const cases: Array<[string, unknown, string]> = [
    ['missing quoteInternalId', [{ estimateInternalId: 'TST-EST-1' }], ''],
    ['missing both estimate refs', [{ quoteInternalId: 'TST-Q-NOEST' }], 'TST-Q-NOEST'],
    ['quoteInternalId > 50 chars', [{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'X'.repeat(51) }], 'X'.repeat(51)],
    ['quoteDocumentNumber > 100', [{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-LONGDOC', quoteDocumentNumber: 'D'.repeat(101) }], 'TST-Q-LONGDOC'],
    ['estimateDocumentNumber > 100', [{ estimateDocumentNumber: 'D'.repeat(101), quoteInternalId: 'TST-Q-LONGEST' }], 'TST-Q-LONGEST'],
    ['garbage string body', 'not an object', ''],
  ];
  for (const [label, body, nsId] of cases) {
    const r = await post(body);
    check(`11 ${label} → rejected 4xx`, r.status >= 400 && r.status < 500, `${r.status} (500 = app.ts error-handler ordering)`);
    if (nsId) check(`11 ${label} wrote nothing`, (await rowsFor(nsId)).length === 0);
  }
  check('11 empty array → 400', (await post([])).status === 400);
  check('11 exactly 50-char quote id accepted', (await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'A'.repeat(50) }])).status === 201);
}
// ═══ 12 LINE SCOPING ══════════════════════════════════════════════════════════
{
  await db.update(estimateLineItems).set({ converted: false }).where(eq(estimateLineItems.netsuiteInternalId, 'TST-LI-3'));
  const r = await post([{ estimateInternalId: 'TST-EST-2', quoteInternalId: 'TST-Q-SCOPE', lineItemInternalIds: ['TST-LI-3', 'TST-LI-E2'] }]);
  check('12 cross-estimate line ignored', (await db.select({ c: estimateLineItems.converted }).from(estimateLineItems).where(eq(estimateLineItems.netsuiteInternalId, 'TST-LI-3')))[0].c === false);
  check('12 own line flipped', (await db.select({ c: estimateLineItems.converted }).from(estimateLineItems).where(eq(estimateLineItems.netsuiteInternalId, 'TST-LI-E2')))[0].c === true);
  check('12 count = real matches only', r.body.succeeded[0].updatedLineItems === 1);
  check('12 unknown line ids → 0 flipped', (await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-1', lineItemInternalIds: ['NOPE-1'] }])).body.succeeded[0].updatedLineItems === 0);
  const many = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-MANYLI', lineItemInternalIds: Array.from({ length: 500 }, (_, i) => `BULK-${i}`).concat(['TST-LI-1']) }]);
  check('12 501-id list handled', many.status === 201 && many.body.succeeded[0].updatedLineItems === 1);
}
// ═══ 13 PRECEDENCE ════════════════════════════════════════════════════════════
{
  check('13 internal id beats doc number', (await post([{ estimateInternalId: 'TST-EST-1', estimateDocumentNumber: 'TST-DOC-4', quoteInternalId: 'TST-Q-PREC', quoteDocumentNumber: 'TST-QD-PREC' }])).body.succeeded[0].estimateId === E1.id);
  check('13 unresolvable id falls back to doc number', (await post([{ estimateInternalId: 'TST-GARBAGE', estimateDocumentNumber: 'TST-DOC-4', quoteInternalId: 'TST-Q-FB' }])).body.succeeded?.[0]?.estimateId === E4.id);
  const [orphan2] = await db.insert(estimateQuotes).values({ estimateId: E4.id, quoteNetsuiteInternalId: null, quoteDocumentNumber: 'TST-QD-PREC2', status: 'active', syncStatus: 'failed' }).returning({ id: estimateQuotes.id });
  await db.insert(estimateQuotes).values({ estimateId: E4.id, quoteNetsuiteInternalId: 'TST-Q-PREC2', quoteDocumentNumber: 'other', status: 'active', syncStatus: 'synced' });
  const pr = await post([{ estimateInternalId: 'TST-EST-4', quoteInternalId: 'TST-Q-PREC2', quoteDocumentNumber: 'TST-QD-PREC2' }]);
  check('13 NS-id match beats orphan adoption', pr.body.succeeded[0].action === 'updated' && (await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, orphan2.id)))[0].quoteNetsuiteInternalId === null);
}
// ═══ 14 GET LIST ══════════════════════════════════════════════════════════════
{
  const byEst = await get('?estimateInternalId=TST-EST-1');
  check('14 filter estimateInternalId', byEst.status === 200 && byEst.body.data.length > 0 && byEst.body.data.every((d: any) => d.estimateInternalId === 'TST-EST-1'));
  check('14 filter status', (await get('?status=replaced')).body.data.every((d: any) => d.status === 'replaced'));
  check('14 limit capped at 500', (await get('?limit=1000')).body.limit === 500);
  const p1 = await get('?page=1&limit=2'), p2 = await get('?page=2&limit=2');
  check('14 pages do not overlap', !p1.body.data.some((a: any) => p2.body.data.some((b: any) => a.id === b.id)) && p1.body.data.length === 2);
  check('14 total numeric', typeof p1.body.total === 'number');
  const far = await get('?page=9999&limit=50');
  check('14 out-of-range page → empty, total intact', far.body.data.length === 0 && far.body.total > 0);
  check('14 invalid status filter rejected', (await get('?status=bogus')).status >= 400);
  check('14 page=0 rejected', (await get('?page=0')).status >= 400);
  check('14 combined filters', (await get('?estimateInternalId=TST-EST-1&status=active&page=1&limit=5')).status === 200);
}
// ═══ 15 GET /:estimateId ══════════════════════════════════════════════════════
{
  const r = await get(`/${E1.id}`);
  check('15 counts match', r.status === 200 && r.body.quoteCount === r.body.quotes.length && r.body.quoteCount > 0);
  check('15 NS ids echoed', r.body.estimateInternalId === 'TST-EST-1' && r.body.estimateDocumentNumber === 'TST-DOC-1');
  check('15 unknown id → 404', (await get('/99999999')).status === 404);
  check('15 non-numeric id rejected', (await get('/abc')).status >= 400);
}
// ═══ 16 RE-POINT ══════════════════════════════════════════════════════════════
{
  const r = await post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-2', quoteDocumentNumber: 'TST-QD-2' }]);
  const rows = await rowsFor('TST-Q-2');
  check('16 re-pointed to another estimate', r.body.updated === 1 && rows[0].estimateId === E3.id);
  check('16 still one row', rows.length === 1);
}
// ═══ 17 ORM RELATIONS ═════════════════════════════════════════════════════════
{
  const e: any = await db.query.estimates.findFirst({ where: eq(estimates.id, E1.id), columns: { id: true }, with: { quotes: { columns: { id: true } } } });
  check('17 estimate.quotes loads', e?.quotes?.length > 0);
  const q: any = await db.query.estimateQuotes.findFirst({ where: eq(estimateQuotes.quoteNetsuiteInternalId, 'TST-Q-1'), columns: { id: true }, with: { estimate: { columns: { id: true } } } });
  check('17 quote.estimate loads', q?.estimate?.id === E1.id);
}
// ═══ 18 CONCURRENCY: same quote id, 8 parallel requests ═══════════════════════
{
  const payload = [{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-RACE', quoteDocumentNumber: 'TST-QD-RACE' }];
  const res = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
  const rows = await rowsFor('TST-Q-RACE');
  check('18 all 8 concurrent requests 201', res.every(r => r.status === 201), res.map(r => r.status).join(','));
  check('18 → exactly ONE row (race guard)', rows.length === 1, `${rows.length} rows`);
  const created = res.reduce((n, r) => n + (r.body?.created ?? 0), 0);
  check('18 exactly one request reports created', created === 1, `${created} reported created`);
}
// ═══ 19 CONCURRENCY: same quote across DIFFERENT estimates ═══════════════════
{
  const res = await Promise.all([
    post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-RACE2', quoteDocumentNumber: 'd1' }]),
    post([{ estimateInternalId: 'TST-EST-2', quoteInternalId: 'TST-Q-RACE2', quoteDocumentNumber: 'd2' }]),
    post([{ estimateInternalId: 'TST-EST-3', quoteInternalId: 'TST-Q-RACE2', quoteDocumentNumber: 'd3' }]),
  ]);
  const rows = await rowsFor('TST-Q-RACE2');
  check('19 conflicting parents → still ONE row', rows.length === 1, `${rows.length} rows`);
  check('19 all requests succeeded', res.every(r => r.status === 201), res.map(r => r.status).join(','));
}
// ═══ 20 CONCURRENCY: parallel batches of distinct quotes ═════════════════════
{
  const mkBatch = (tag: string) => Array.from({ length: 5 }, (_, i) => ({ estimateInternalId: 'TST-EST-1', quoteInternalId: `TST-PAR${tag}-${i}`, quoteDocumentNumber: `doc-${tag}-${i}` }));
  const res = await Promise.all([post(mkBatch('A')), post(mkBatch('B')), post(mkBatch('C'))]);
  check('20 three parallel 5-record batches 201', res.every(r => r.status === 201), res.map(r => r.status).join(','));
  check('20 all 15 distinct rows written once', await countLike('TST-PAR%') === 15, `${await countLike('TST-PAR%')} rows`);
}
// ═══ 21 SCALE + THROUGHPUT + BOUNDARY ═════════════════════════════════════════
{
  const N = 25;
  const batch = Array.from({ length: N }, (_, i) => ({ estimateInternalId: 'TST-EST-2', quoteInternalId: `TST-BIG-${i}`, quoteDocumentNumber: `bigdoc-${i}` }));
  const r = await post(batch);
  check(`21 ${N}-record batch 201`, r.status === 201, `${r.status}`);
  check(`21 all ${N} created`, r.body.created === N, `${r.body.created}`);
  check(`21 ${N} rows stored`, await countLike('TST-BIG-%') === N);
  const perRec = r.body.durationMs / N;
  console.log(`   THROUGHPUT: ${N} new records in ${r.body.durationMs}ms = ${perRec.toFixed(0)}ms/record (insert path, incl. race guard)`);
  const again = await post(batch);
  const perRec2 = again.body.durationMs / N;
  console.log(`   THROUGHPUT: ${N} re-synced records in ${again.body.durationMs}ms = ${perRec2.toFixed(0)}ms/record (update path)`);
  console.log(`   → 2000-record batch ≈ ${((perRec * 2000) / 1000).toFixed(0)}s new / ${((perRec2 * 2000) / 1000).toFixed(0)}s re-sync (requestTimeout is 60s)`);
  check(`21 re-run ${N} → all updated`, again.body.updated === N && again.body.created === 0);
  check(`21 still ${N} rows`, await countLike('TST-BIG-%') === N);
  const over = await post(Array.from({ length: 2001 }, (_, i) => ({ estimateInternalId: 'TST-EST-2', quoteInternalId: `TST-OVER-${i}` })));
  check('21 2001 records → 400', over.status === 400, `${over.status}`);
  check('21 oversized batch wrote nothing', await countLike('TST-OVER-%') === 0);
  check('21 safe page size for 60s timeout is documented-worthy', perRec * 2000 > 60_000, `projected ${(perRec * 2000 / 1000).toFixed(0)}s`);
}
// ═══ 22 DRY RUN vs EXISTING ═══════════════════════════════════════════════════
{
  const r = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-1', quoteDocumentNumber: 'CHANGED-IN-DRYRUN' }], '?dryRun=true');
  check('22 would_update on existing', r.body.succeeded[0].action === 'would_update');
  check('22 reports existing row id', r.body.succeeded[0].quoteId !== null);
  check('22 row unchanged', (await rowsFor('TST-Q-1'))[0].quoteDocumentNumber !== 'CHANGED-IN-DRYRUN');
}
// ═══ 23 PRE-EXISTING DUPLICATES ═══════════════════════════════════════════════
{
  await db.insert(estimateQuotes).values([
    { estimateId: E1.id, quoteNetsuiteInternalId: 'TST-Q-PREDUP', quoteDocumentNumber: 'dupA', status: 'active', syncStatus: 'synced' },
    { estimateId: E1.id, quoteNetsuiteInternalId: 'TST-Q-PREDUP', quoteDocumentNumber: 'dupB', status: 'active', syncStatus: 'synced' },
    { estimateId: E1.id, quoteNetsuiteInternalId: 'TST-Q-PREDUP', quoteDocumentNumber: 'dupC', status: 'active', syncStatus: 'synced' },
  ]);
  const r = await post([{ estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-PREDUP', quoteDocumentNumber: 'dupFIXED' }]);
  const rows = await rowsFor('TST-Q-PREDUP');
  check('23 no new row added', rows.length === 3, `${rows.length}`);
  check('23 sync still succeeds', r.status === 201);
  check('23 one dupe refreshed (others stale)', rows.filter(x => x.quoteDocumentNumber === 'dupFIXED').length === 1);
}
// ═══ 24 ENVELOPE INTEGRITY ════════════════════════════════════════════════════
{
  const r = await post([
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-ENV1' },
    { estimateInternalId: 'TST-BADREF', quoteInternalId: 'TST-Q-ENV2' },
    { estimateInternalId: 'TST-EST-1', quoteInternalId: 'TST-Q-ENV3' },
  ]);
  const b = r.body;
  check('24 total = success + failure', b.total === b.successCount + b.failureCount && b.total === 3);
  check('24 created + updated = successCount', b.created + b.updated === b.successCount);
  check('24 indexes map to payload positions', b.succeeded.map((s: any) => s.index).join(',') === '0,2');
  check('24 durationMs numeric', typeof b.durationMs === 'number' && b.durationMs >= 0);
  check('24 succeeded rows carry quoteId + estimateId', b.succeeded.every((s: any) => typeof s.quoteId === 'number' && typeof s.estimateId === 'number'));
}

// ─── TEARDOWN ────────────────────────────────────────────────────────────────
const ids = [E1.id, E2.id, E3.id, E4.id];
const testQuotes = (await db.select({ c: raw<number>`count(*)::int` }).from(estimateQuotes).where(inArray(estimateQuotes.estimateId, ids)))[0].c;
await db.delete(estimates).where(inArray(estimates.id, ids));
const finalCount = await count();
check('teardown: every test quote cascaded', finalCount === baseline, `${finalCount} vs ${baseline}`);
check('teardown: every test line item cascaded', (await db.select({ c: raw<number>`count(*)::int` }).from(estimateLineItems).where(inArray(estimateLineItems.estimateId, ids)))[0].c === 0);
check('teardown: no TST-* rows left', await countLike('TST-%') === 0);

console.log('\n' + results.join('\n'));
console.log(`\ncleaned ${testQuotes} test quote rows + 4 estimates — estimate_quotes back to ${finalCount} (baseline ${baseline})`);
console.log(`\n== ${pass} passed, ${fail} failed ==`);
if (fail) console.log('\nFAILURES:\n' + results.filter(r => r.startsWith('FAIL')).join('\n'));
await closeDb();
process.exit(fail === 0 ? 0 : 1);
