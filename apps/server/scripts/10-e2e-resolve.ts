/**
 * E2E resolution test on the pool program, against the finished fixture
 * France vs Morocco (18209181, kicked off 2026-07-09T20:00Z).
 *
 * Creates a fresh O/U 2.5 pool market with lock_ts = kickoff (already past →
 * no deposits possible; this test exercises proof → CPI validate_stat →
 * outcome storage, i.e. the trustless heart of the product).
 */
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { DEVNET, type PlainTerms } from '@groundtruth/shared';
import {
  createMarket,
  createPoolProgram,
  resolveMarket,
  rootPdaForBundle,
  toStatProofBundle,
} from '@groundtruth/chain';
import { bootstrap } from './env.js';

const FIXTURE = 18209181; // France vs Morocco
const KICKOFF_TS = Math.floor(Date.UTC(2026, 6, 9, 20, 0, 0) / 1000);

const { keypair, connection, client } = await bootstrap();
const pool = createPoolProgram(connection, keypair);

// Final state (snapshot may be pruned for older fixtures → replay fallback)
let snaps = await client.scoresSnapshot(FIXTURE);
let withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
if (!withStats.length) {
  console.log(`snapshot empty (${snaps.length} records) — replaying historical stream`);
  snaps = await client.scoresHistorical(FIXTURE);
  withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
  console.log(`historical: ${snaps.length} records, ${withStats.length} with stats`);
}
const last = withStats.reduce((a, b) => (b.Seq > a.Seq ? b : a));
const g1 = last.Stats?.['1'] ?? 0;
const g2 = last.Stats?.['2'] ?? 0;
console.log(`Final: seq=${last.Seq} statusId=${last.StatusId} goals P1=${g1} P2=${g2}`);

const terms: PlainTerms = {
  fixtureId: FIXTURE,
  period: 0,
  statAKey: 1,
  statBKey: 2,
  predicate: { threshold: 2, comparison: 'GreaterThan' },
  op: 'Add',
  negation: false,
};
const expectYes = g1 + g2 > 2;

// Create (idempotent per terms — may already exist from an earlier run)
let marketPk: PublicKey;
try {
  const res = await createMarket(pool, keypair, terms, {
    lockTs: KICKOFF_TS,
    resolveDeadlineTs: KICKOFF_TS + 7 * 86400,
  });
  marketPk = res.market;
  console.log(`market created: ${res.market.toBase58()} (${res.signature})`);
} catch (err) {
  if (!/already in use/.test(String(err))) throw err;
  const { fromPlainTerms, marketPda } = await import('@groundtruth/chain');
  marketPk = marketPda(fromPlainTerms(terms));
  console.log(`market existed: ${marketPk.toBase58()}`);
}

// Proof for the final record
const val = await client.statValidation(FIXTURE, last.Seq, 1, 2);
const bundle = toStatProofBundle(val);
const { pda: rootsPda, epochDay } = rootPdaForBundle(bundle);
console.log(`proof: statA=${val.statToProve.value} statB=${val.statToProve2?.value} rootDay=${epochDay}`);

const sig = await resolveMarket(pool, keypair, marketPk, bundle, rootsPda);
console.log(`RESOLVED: ${DEVNET.explorerTxUrl(sig)}`);

const market = await pool.account.market.fetch(marketPk);
console.log(
  `on-chain state=${JSON.stringify(market.state)} winnerYes=${market.winnerYes} ` +
    `evidenceTs=${market.evidenceTs} disputeUntil=${market.disputeUntilTs}`,
);
if (market.winnerYes === expectYes && 'resolved' in (market.state as object)) {
  console.log(`E2E RESOLUTION PASSED: on-chain winner ${market.winnerYes ? 'YES(Over)' : 'NO(Under)'} matches reality (${g1 + g2} goals).`);
} else {
  console.error('E2E MISMATCH');
  process.exitCode = 1;
}
