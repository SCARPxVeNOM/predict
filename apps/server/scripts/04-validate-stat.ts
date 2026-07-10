/**
 * Smoke 4 (M1 gate): read-only on-chain validate_stat against a finished fixture.
 *
 * Usage: tsx scripts/04-validate-stat.ts [fixtureId]
 * Without an argument it discovers a recently finished fixture via the
 * historical scores endpoint (start time 6h–2w in the past).
 *
 * Proves: P1 goals + P2 goals > -1 (always true for a valid proof) and the
 * negated comparison (expected false), plus a two-stat late-game proof to
 * measure compute against the ProofTooLarge/budget concern (spec §13).
 */
import { epochDay } from '@groundtruth/shared';
import { rootPdaForBundle, toStatProofBundle, validateStatView } from '@groundtruth/chain';
import { bootstrap } from './env.js';

// `.view()` simulations still need an existing (funded) fee-payer account,
// so run them through the keeper-bound program.
const { client, program } = await bootstrap();

let fixtureId = process.argv[2] ? Number(process.argv[2]) : undefined;

if (!fixtureId) {
  // Find a fixture that started 6h+ ago from yesterday's/today's coverage.
  const fixtures = await client.fixturesSnapshot({ startEpochDay: epochDay() - 7 });
  const cutoffHi = Date.now() - 6.5 * 3600_000;
  const cutoffLo = Date.now() - 13 * 86_400_000;
  const finished = fixtures
    .filter((f) => f.StartTime > cutoffLo && f.StartTime < cutoffHi)
    .sort((a, b) => b.StartTime - a.StartTime);
  if (!finished.length) throw new Error('No recently finished fixture found; pass a fixtureId.');
  fixtureId = finished[0]!.FixtureId;
  console.log(
    `Using finished fixture #${fixtureId}: ${finished[0]!.Participant1} vs ${finished[0]!.Participant2}`,
  );
}

// Highest-seq snapshot record that carries stats = final provable state.
const snapshots = await client.scoresSnapshot(fixtureId);
if (!snapshots.length) throw new Error(`No score snapshots for fixture ${fixtureId}`);
const withStats = snapshots.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
if (!withStats.length) throw new Error('No snapshot records carry a Stats map');
const last = withStats.reduce((a, b) => (b.Seq > a.Seq ? b : a));
console.log(
  `Final record: seq=${last.Seq} statusId=${last.StatusId} ` +
    `P1 total=${JSON.stringify(last.Score?.Participant1?.Total)} ` +
    `P2 total=${JSON.stringify(last.Score?.Participant2?.Total)}`,
);

// Two-stat proof: total goals = P1 goals (key 1) + P2 goals (key 2).
const val = await client.statValidation(fixtureId, last.Seq, 1, 2);
const bundle = toStatProofBundle(val);
const { pda, epochDay: day } = rootPdaForBundle(bundle);
console.log(
  `Proof: statA=${JSON.stringify(val.statToProve)} statB=${JSON.stringify(val.statToProve2)} ` +
    `root day=${day} pda=${pda.toBase58()}`,
);
console.log(
  `Proof sizes: statProof=${val.statProof.length} statProof2=${val.statProof2?.length} ` +
    `subTree=${val.subTreeProof.length} mainTree=${val.mainTreeProof.length} nodes`,
);

// (P1 + P2 goals) > -1 — must be true when the proof verifies.
const truthy = await validateStatView(
  program,
  bundle,
  { threshold: -1, comparison: { greaterThan: {} } },
  { add: {} },
);
console.log(`validate_stat (goals sum > -1): ${truthy} ${truthy ? '✔' : '✘ EXPECTED TRUE'}`);

// (P1 + P2 goals) < -1 — must be false (proof valid, predicate fails → returns false).
const falsy = await validateStatView(
  program,
  bundle,
  { threshold: -1, comparison: { lessThan: {} } },
  { add: {} },
);
console.log(`validate_stat (goals sum < -1): ${falsy} ${!falsy ? '✔' : '✘ EXPECTED FALSE'}`);

if (truthy && !falsy) {
  console.log('M1 GATE PASSED: on-chain proof validation round-trip works.');
} else {
  process.exitCode = 1;
}
