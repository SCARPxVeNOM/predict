import Fastify from 'fastify';
import cors from '@fastify/cors';
import { and, eq, inArray } from 'drizzle-orm';
import { createPoolProgram } from '@groundtruth/chain';
import { config } from './config.js';
import { db, migrate, schema } from './db/index.js';
import { registerRoutes } from './api/routes.js';
import { buildContext } from './services/txline.js';
import { startAutoMarketEngine } from './services/autoMarket.js';
import { startIndexer } from './services/indexer.js';
import { startSettler } from './services/settler.js';
import { startPositionIndexer } from './services/positions.js';
import { startAiMarketAuthor } from './services/aiMarkets.js';

// Never let a transient RPC failure (429s etc.) kill the whole process —
// every service has its own retry loop.
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandled rejection:', String(err).slice(0, 300));
});

migrate();

// One-shot: after the pool-program upgrade that accepts the final-archival
// proof period, requeue the listed fixtures' DB-voided markets (still Open
// on-chain, deadline not passed) so the settler re-attempts real proof
// settlement instead of leaving them to refund. Set the env var for one
// deploy, then remove it. Genuinely-unresolvable markets (EvidenceTooEarly)
// simply re-void, so this is safe to run broadly.
if (process.env.REQUEUE_VOID_FIXTURES) {
  const ids = process.env.REQUEUE_VOID_FIXTURES.split(',').map((s) => Number(s.trim())).filter(Boolean);
  const rows = await db.query.markets.findMany({
    where: and(inArray(schema.markets.fixtureId, ids), eq(schema.markets.state, 'Void')),
  });
  let n = 0;
  const now = Date.now();
  for (const m of rows) {
    if (!m.marketPda || now >= m.resolveDeadlineTs) continue;
    await db
      .update(schema.markets)
      .set({ state: 'AwaitingRoot', winnerYes: null, updatedAt: now })
      .where(eq(schema.markets.id, m.id));
    n += 1;
  }
  console.log(`[main] requeued ${n} voided markets for re-settlement (fixtures ${ids.join(', ')})`);
}

const ctx = await buildContext();
console.log(`[main] keeper ${ctx.keeper.publicKey.toBase58()} | TxLINE session active`);

const pool = createPoolProgram(ctx.connection, ctx.keeper);
console.log(`[main] pool program ${pool.programId.toBase58()}`);

const stops = [
  startAutoMarketEngine(ctx, pool),
  startIndexer(ctx),
  startSettler(ctx, pool),
  startPositionIndexer(pool),
  startAiMarketAuthor(ctx, pool),
];
console.log(
  `[main] AI market author: ${config.geminiApiKey ? `Gemini (${config.geminiModel})` : 'deterministic only — set GEMINI_API_KEY in .env to enable'}`,
);

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
registerRoutes(app);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[main] API listening on :${config.port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const stop of stops) stop();
    void app.close().then(() => process.exit(0));
  });
}
