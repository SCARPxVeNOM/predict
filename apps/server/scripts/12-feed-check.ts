/** Peek at the live feed state for a fixture (bypasses our indexer). */
import { bootstrap } from './env.js';

const fixtureId = Number(process.argv[2] ?? 18209181);
const { client } = await bootstrap();

const updates = await client.scoresUpdates(fixtureId).catch((e) => {
  console.log('updates error:', String(e).slice(0, 120));
  return [];
});
console.log(`current-interval updates: ${updates.length}`);
for (const u of updates.slice(-5)) {
  console.log(
    `  seq=${u.Seq} ts=${new Date(u.Ts).toISOString()} action=${u.Action} status=${u.StatusId} ` +
      `goals=${u.Stats?.['1'] ?? '-'}:${u.Stats?.['2'] ?? '-'}`,
  );
}

const snaps = await client.scoresSnapshot(fixtureId);
const bySeq = snaps.sort((a, b) => a.Seq - b.Seq);
console.log(`snapshot records: ${snaps.length}`);
for (const s of bySeq.slice(-5)) {
  console.log(
    `  seq=${s.Seq} ts=${new Date(s.Ts).toISOString()} action=${s.Action} status=${s.StatusId}`,
  );
}
