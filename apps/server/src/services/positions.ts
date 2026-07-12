import { eq } from 'drizzle-orm';
import type { Program } from '@coral-xyz/anchor';
import type { GroundtruthPool } from '@groundtruth/chain';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { bus } from './bus.js';

/**
 * Position indexer + leaderboard (spec §10.4). Polls the pool program's
 * Position accounts, mirrors them into the DB, keeps market pool totals in
 * sync, and recomputes wallet P&L / verified-accuracy after settlement.
 */
export function startPositionIndexer(pool: Program<GroundtruthPool>) {
  let stopped = false;

  async function tick() {
    const now = Date.now();
    const marketRows = await db.query.markets.findMany();
    const byPda = new Map(marketRows.filter((m) => m.marketPda).map((m) => [m.marketPda!, m]));

    const positions = await pool.account.position.all();
    const byMarket = new Map<string, { yes: number; no: number; wallets: Set<string> }>();

    for (const { publicKey, account } of positions) {
      const market = byPda.get(account.market.toBase58());
      if (!market) continue;

      const amount = Number(account.amount);
      await db
        .insert(schema.positions)
        .values({
          id: publicKey.toBase58(),
          marketId: market.id,
          wallet: account.owner.toBase58(),
          sideYes: account.sideYes,
          amount,
          claimed: account.claimed,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.positions.id,
          set: { amount, claimed: account.claimed, updatedAt: now },
        });

      const agg = byMarket.get(market.id) ?? { yes: 0, no: 0, wallets: new Set<string>() };
      if (account.sideYes) agg.yes += amount;
      else agg.no += amount;
      agg.wallets.add(account.owner.toBase58());
      byMarket.set(market.id, agg);
    }

    for (const [marketId, agg] of byMarket) {
      const m = byPda.size ? marketRows.find((r) => r.id === marketId) : undefined;
      if (!m) continue;
      if (m.yesPool !== agg.yes || m.noPool !== agg.no || m.participantCount !== agg.wallets.size) {
        await db
          .update(schema.markets)
          .set({
            yesPool: agg.yes,
            noPool: agg.no,
            participantCount: agg.wallets.size,
            updatedAt: now,
          })
          .where(eq(schema.markets.id, marketId));
        // Real price-history point (drives card sparklines).
        const total = agg.yes + agg.no;
        await db.insert(schema.poolHistory).values({
          marketId,
          ts: now,
          impliedYesBps: total > 0 ? Math.round((agg.yes / total) * 10_000) : 5_000,
          volume: total,
        });
        bus.emit('market', {
          id: marketId,
          yesPool: agg.yes,
          noPool: agg.no,
          participants: agg.wallets.size,
        });
      }
    }

    await recomputeLeaderboard(marketRows);
  }

  async function recomputeLeaderboard(marketRows: (typeof schema.markets.$inferSelect)[]) {
    const now = Date.now();
    const settled = new Map(
      marketRows.filter((m) => m.state === 'Settled' || m.state === 'Void').map((m) => [m.id, m]),
    );
    const allPositions = await db.query.positions.findMany();

    const profiles = new Map<
      string,
      { pnl: number; staked: number; wins: number; losses: number; verifiedWins: number }
    >();
    for (const p of allPositions) {
      const prof =
        profiles.get(p.wallet) ?? { pnl: 0, staked: 0, wins: 0, losses: 0, verifiedWins: 0 };
      prof.staked += p.amount / 1e6;
      const m = settled.get(p.marketId);
      if (m && m.state === 'Settled' && m.winnerYes !== null) {
        const won = p.sideYes === m.winnerYes;
        const winnerPool = m.winnerYes ? m.yesPool : m.noPool;
        const loserPool = m.winnerYes ? m.noPool : m.yesPool;
        if (won) {
          const share = winnerPool > 0 ? (p.amount * loserPool) / winnerPool : 0;
          prof.pnl += share / 1e6;
          prof.wins += 1;
          if (m.marketClass === 'A') prof.verifiedWins += 1;
        } else {
          prof.pnl -= p.amount / 1e6;
          prof.losses += 1;
        }
      }
      profiles.set(p.wallet, prof);
    }

    for (const [wallet, prof] of profiles) {
      await db
        .insert(schema.walletProfiles)
        .values({
          wallet,
          realizedPnl: prof.pnl,
          staked: prof.staked,
          wins: prof.wins,
          losses: prof.losses,
          verifiedWins: prof.verifiedWins,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.walletProfiles.wallet,
          set: {
            realizedPnl: prof.pnl,
            staked: prof.staked,
            wins: prof.wins,
            losses: prof.losses,
            verifiedWins: prof.verifiedWins,
            updatedAt: now,
          },
        });
    }
  }

  const loop = async () => {
    let backoff = 0;
    while (!stopped) {
      try {
        await tick();
        backoff = 0;
      } catch (err) {
        const s = String(err);
        // On rate-limit (429), back off hard so we don't feed a retry storm
        // that can starve the health server and get the container killed.
        backoff = /429|Too Many Requests|rate limit/i.test(s)
          ? Math.min(config.failureBackoffMs, (backoff || config.pollPositionsMs) * 2)
          : 0;
        console.error(`[positions] tick failed (backoff ${backoff}ms):`, s.slice(0, 200));
      }
      await new Promise((r) => setTimeout(r, config.pollPositionsMs + backoff));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
