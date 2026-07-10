/** Diagnose StatMismatch on first-half markets: what key/period does the
 * stat-validation proof actually carry for an H1 stat? */
import { bootstrap } from './env.js';

const fixtureId = Number(process.argv[2] ?? 18218149);
const { client } = await bootstrap();

const snaps = await client.scoresSnapshot(fixtureId);
// Same record the settler picks: highest seq that carries Stats.
const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
const deciding = withStats.reduce((a, b) => (b.Seq > a.Seq ? b : a));
console.log(
  `deciding seq=${deciding.Seq} status=${deciding.StatusId} statsKeys=${Object.keys(deciding.Stats!).sort((x, y) => Number(x) - Number(y)).join(',')}`,
);
const seq = deciding.Seq;

for (const [a, b] of [
  [1001, 1002],
  [1, 2],
] as const) {
  try {
    const v = await client.statValidation(fixtureId, seq, a, b);
    console.log(
      `query statKey=${a},${b} → statToProve=${JSON.stringify(v.statToProve)} statToProve2=${JSON.stringify(v.statToProve2)}`,
    );
  } catch (err) {
    console.log(`query statKey=${a},${b} → ERROR ${String(err).slice(0, 160)}`);
  }
}
