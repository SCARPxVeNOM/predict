/** Report the on-chain MarketState of a fixture's pool markets — decides
 * whether the voided markets can still be resolved (Open) or are already
 * voided on-chain (refund-only). */
import { PublicKey } from '@solana/web3.js';
import { createPoolProgram } from '@groundtruth/chain';
import { bootstrap } from './env.js';

const API = 'https://groundtruth-server-production-569f.up.railway.app';
const fixtureId = Number(process.argv[2] ?? 18213979);
const { connection, keypair } = await bootstrap();
const pool = createPoolProgram(connection, keypair);

const ms = (await (await fetch(`${API}/api/markets?fixtureId=${fixtureId}`)).json()) as {
  slug: string;
  marketPda: string | null;
}[];
const withPda = ms.filter((m) => m.marketPda);

const tally: Record<string, number> = {};
for (const m of withPda) {
  try {
    const acc = await pool.account.market.fetch(new PublicKey(m.marketPda!));
    const st = Object.keys(acc.state as object)[0]!;
    tally[st] = (tally[st] ?? 0) + 1;
  } catch (e) {
    tally['fetchErr'] = (tally['fetchErr'] ?? 0) + 1;
  }
}
console.log(`fixture ${fixtureId} on-chain states:`, JSON.stringify(tally));
process.exit(0);
