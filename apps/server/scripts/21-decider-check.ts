/** For a match that went to ET/penalties: find the right deciding record.
 * The undocumented status=100 archival record returns proof period 100 and
 * breaks settlement — a valid finished-status record should return period 0. */
import { bootstrap } from './env.js';

const fixtureId = Number(process.argv[2] ?? 18213979);
const { client } = await bootstrap();
const snaps = await client.scoresSnapshot(fixtureId);
const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);

// Show the last few stat-bearing records with their status + proof period.
const sorted = withStats.sort((a, b) => a.Seq - b.Seq);
for (const s of sorted.slice(-6)) {
  const v = await client.statValidation(fixtureId, s.Seq, 1, 2);
  console.log(
    `seq=${s.Seq} status=${s.StatusId} → proofPeriod=${v.statToProve.period} goals=${v.statToProve.value}-${v.statToProve2?.value}`,
  );
}

// The record we WANT: highest seq whose StatusId is a real (1-19) finished code.
const FINISHED = new Set([5, 10, 13]);
const valid = sorted.filter((s) => s.StatusId !== undefined && FINISHED.has(s.StatusId));
const best = valid.length ? valid[valid.length - 1]! : null;
console.log('\nbest finished-status record:', best ? `seq=${best.Seq} status=${best.StatusId}` : 'NONE');
if (best) {
  const v = await client.statValidation(fixtureId, best.Seq, 1, 2);
  console.log(`  → proofPeriod=${v.statToProve.period} goals=${v.statToProve.value}-${v.statToProve2?.value}`);
}
