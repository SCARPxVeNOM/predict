import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createPoolProgram } from '@groundtruth/chain';
import { config } from './config.js';
import { db, migrate } from './db/index.js';
import { registerRoutes } from './api/routes.js';
import { buildContext } from './services/txline.js';
import { startAutoMarketEngine } from './services/autoMarket.js';
import { startIndexer } from './services/indexer.js';
import { startSettler } from './services/settler.js';
import { startPositionIndexer } from './services/positions.js';

// Never let a transient RPC failure (429s etc.) kill the whole process —
// every service has its own retry loop.
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandled rejection:', String(err).slice(0, 300));
});

migrate();

const ctx = await buildContext();
console.log(`[main] keeper ${ctx.keeper.publicKey.toBase58()} | TxLINE session active`);

const pool = createPoolProgram(ctx.connection, ctx.keeper);
console.log(`[main] pool program ${pool.programId.toBase58()}`);

const stops = [
  startAutoMarketEngine(ctx, pool),
  startIndexer(ctx),
  startSettler(ctx, pool),
  startPositionIndexer(pool),
];

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
