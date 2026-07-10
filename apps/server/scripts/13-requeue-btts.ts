/** One-off: requeue the mis-settled composite market so the fixed settler redoes it. */
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const id = '18209181:btts';
await db.delete(schema.receipts).where(eq(schema.receipts.marketId, id));
await db
  .update(schema.markets)
  .set({ state: 'AwaitingRoot', winnerYes: null, updatedAt: Date.now() })
  .where(eq(schema.markets.id, id));
console.log(`requeued ${id}`);
process.exit(0);
