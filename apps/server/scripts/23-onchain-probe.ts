/** Probe which late record's proof the on-chain oracle ACCEPTS right now.
 * Uses the read-only validate_stat .view() (no funds) per candidate so we
 * can see period + whether it validates against the currently-posted root. */
import { bootstrap } from './env.js';
import { createProgram, toStatProofBundle, validateStatView } from '@groundtruth/chain';

const fixtureId = Number(process.argv[2] ?? 18213979);
const { connection, keypair, client } = await bootstrap();
const oracle = createProgram(connection, keypair);

const recs = (await client.scoresSnapshot(fixtureId))
  .filter((s) => s.Stats && Object.keys(s.Stats).length > 0)
  .sort((a, b) => a.Seq - b.Seq)
  .slice(-8);

for (const s of recs) {
  try {
    const val = await client.statValidation(fixtureId, s.Seq, 1, 2);
    const bundle = toStatProofBundle(val);
    let result: string;
    try {
      const ok = await validateStatView(
        oracle,
        bundle,
        { threshold: 0, comparison: { greaterThan: {} } },
        { add: {} },
      );
      result = `ACCEPTED (predicate=${ok})`;
    } catch (err) {
      result = `REJECTED ${String(err).match(/Error Code: (\w+)/)?.[1] ?? String(err).slice(0, 60)}`;
    }
    console.log(`seq=${s.Seq} status=${s.StatusId} period=${val.statToProve.period} → ${result}`);
  } catch (err) {
    console.log(`seq=${s.Seq} status=${s.StatusId} → API ERROR ${String(err).slice(0, 60)}`);
  }
}
