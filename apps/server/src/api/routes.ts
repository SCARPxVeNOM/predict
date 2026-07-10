import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { DEVNET } from '@groundtruth/shared';
import { db, schema } from '../db/index.js';
import { bus } from '../services/bus.js';

/** REST + SSE API consumed by the SPA. */
export function registerRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ ok: true, network: 'devnet' }));

  app.get('/api/fixtures', async () => db.query.fixtures.findMany());

  app.get('/api/markets', async (req) => {
    const { fixtureId, state } = req.query as { fixtureId?: string; state?: string };
    let rows = await db.query.markets.findMany();
    if (fixtureId) rows = rows.filter((m) => m.fixtureId === Number(fixtureId));
    if (state) rows = rows.filter((m) => m.state === state);
    return rows;
  });

  app.get('/api/markets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const market = await db.query.markets.findFirst({ where: eq(schema.markets.id, id) });
    if (!market) return reply.code(404).send({ error: 'not found' });
    const receipt = await db.query.receipts.findFirst({
      where: eq(schema.receipts.marketId, id),
    });
    const positions = await db.query.positions.findMany({
      where: eq(schema.positions.marketId, id),
    });
    return { market, receipt: receipt ?? null, positions };
  });

  /** Receipt + full proof bundle for browser-side re-verification (spec §9). */
  app.get('/api/receipts/:marketId', async (req, reply) => {
    const { marketId } = req.params as { marketId: string };
    const receipt = await db.query.receipts.findFirst({
      where: eq(schema.receipts.marketId, marketId),
    });
    if (!receipt) return reply.code(404).send({ error: 'not found' });
    return {
      ...receipt,
      explorerUrl: receipt.resolveTx ? DEVNET.explorerTxUrl(receipt.resolveTx) : null,
      rootPdaUrl: DEVNET.explorerAddressUrl(receipt.rootPda),
    };
  });

  app.get('/api/wallets/:wallet/positions', async (req) => {
    const { wallet } = req.params as { wallet: string };
    const rows = await db.query.positions.findMany({
      where: eq(schema.positions.wallet, wallet),
    });
    const markets = await db.query.markets.findMany();
    const byId = new Map(markets.map((m) => [m.id, m]));
    return rows.map((p) => ({ ...p, market: byId.get(p.marketId) ?? null }));
  });

  /** Real implied-price history (sparkline source). */
  app.get('/api/markets/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    return db.query.poolHistory.findMany({
      where: eq(schema.poolHistory.marketId, id),
      orderBy: schema.poolHistory.ts,
      limit: 200,
    });
  });

  /** Real Golden Boot standings aggregated from per-match PlayerStats. */
  app.get('/api/tournament/scorers', async () => {
    const rows = await db.query.scorers.findMany();
    return rows.sort((a, b) => b.goals - a.goals).slice(0, 20);
  });

  app.get('/api/leaderboard', async () =>
    db.query.walletProfiles.findMany({
      orderBy: desc(schema.walletProfiles.realizedPnl),
      limit: 100,
    }),
  );

  app.get('/api/notifications', async (req) => {
    const { wallet } = req.query as { wallet?: string };
    const rows = await db.query.notifications.findMany({
      orderBy: desc(schema.notifications.id),
      limit: 50,
    });
    return rows.filter((n) => n.wallet === null || n.wallet === wallet);
  });

  app.post('/api/follows', async (req) => {
    const { follower, followee } = req.body as { follower: string; followee: string };
    await db
      .insert(schema.follows)
      .values({ id: `${follower}:${followee}`, follower, followee, createdAt: Date.now() })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.get('/api/follows/:wallet', async (req) => {
    const { wallet } = req.params as { wallet: string };
    return db.query.follows.findMany({ where: eq(schema.follows.follower, wallet) });
  });

  /** Server-sent events: score + market updates for live cards. */
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (event: string) => (payload: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onScore = send('score');
    const onMarket = send('market');
    bus.on('score', onScore);
    bus.on('market', onMarket);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('score', onScore);
      bus.off('market', onMarket);
    });
  });
}
