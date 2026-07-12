/** For each late record: period, val.ts, and summary min/max timestamps —
 * to find a record that is BOTH period 0 AND ts-consistent with its batch
 * (validate_stat rejects a ts outside the snapshot payload with 6010). */
import { bootstrap } from './env.js';

const fixtureId = Number(process.argv[2] ?? 18213979);
const { client } = await bootstrap();
const snaps = await client.scoresSnapshot(fixtureId);
const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
const sorted = withStats.sort((a, b) => a.Seq - b.Seq);

for (const s of sorted.slice(-8)) {
  try {
    const v = await client.statValidation(fixtureId, s.Seq, 1, 2);
    const min = v.summary.updateStats.minTimestamp;
    const max = v.summary.updateStats.maxTimestamp;
    const inRange = v.ts >= min && v.ts <= max;
    console.log(
      `seq=${s.Seq} status=${s.StatusId} period=${v.statToProve.period} ts=${v.ts} min=${min} max=${max} inRange=${inRange}`,
    );
  } catch (err) {
    console.log(`seq=${s.Seq} status=${s.StatusId} → ERROR ${String(err).slice(0, 100)}`);
  }
}
