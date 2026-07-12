/**
 * After the pool-program upgrade that accepts the final-archival proof
 * period, requeue the extra-time matches that were voided-in-DB (but are
 * still Open on-chain) so the settler re-attempts real proof settlement
 * instead of refunding. Only touches markets whose on-chain deadline has
 * NOT passed (so the market is still resolvable).
 *
 *   pnpm exec tsx scripts/24-requeue-et-voids.ts 18213979 18222446
 */
import { eq, and, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const fixtureIds = process.argv.slice(2).map(Number);
if (!fixtureIds.length) {
  console.error('usage: 24-requeue-et-voids.ts <fixtureId> [<fixtureId> ...]');
  process.exit(1);
}

const now = Date.now();
const rows = await db.query.markets.findMany({
  where: and(
    inArray(schema.markets.fixtureId, fixtureIds),
    eq(schema.markets.state, 'Void'),
  ),
});

let requeued = 0;
for (const m of rows) {
  // Only markets with an on-chain pool that hasn't hit its resolve deadline.
  if (!m.marketPda) continue;
  if (now >= m.resolveDeadlineTs) {
    console.log(`skip ${m.id}: past resolve deadline (would already be void-refundable)`);
    continue;
  }
  await db
    .update(schema.markets)
    .set({ state: 'AwaitingRoot', winnerYes: null, updatedAt: now })
    .where(eq(schema.markets.id, m.id));
  requeued += 1;
  console.log(`requeued ${m.id} → AwaitingRoot`);
}
console.log(`DONE: requeued ${requeued} markets across fixtures ${fixtureIds.join(', ')}`);
process.exit(0);
