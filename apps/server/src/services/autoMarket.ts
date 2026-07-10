import { eq } from 'drizzle-orm';
import { epochDay } from '@groundtruth/shared';
import { classAMarkets } from '@groundtruth/catalog';
import { createMarket, marketPda, vaultPda } from '@groundtruth/chain';
import { fromPlainTerms, termsHashHex } from '@groundtruth/chain';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import type { Ctx } from './txline.js';
import type { Program } from '@coral-xyz/anchor';
import type { GroundtruthPool } from '@groundtruth/chain';

/** How far back the chain-recovery sweep looks for started fixtures. */
const RECOVERY_WINDOW_MS = 3 * 86_400_000;

/**
 * Rebuild catalog market rows for a started fixture from the chain — the
 * on-chain pool account is the source of truth, the DB is just a cache of it.
 * Single-proof markets are recovered only if their PDA actually exists;
 * composite (DB-only) markets are recreated so the settler can prove their
 * legs and settle them.
 */
async function recoverFixtureMarkets(
  pool: Program<GroundtruthPool>,
  f: { FixtureId: number; StartTime: number; Participant1: string; Participant2: string },
  now: number,
) {
  const fxInfo = { fixtureId: f.FixtureId, home: f.Participant1, away: f.Participant2 };
  const defs = [...classAMarkets(fxInfo), ...classAMarkets(fxInfo, 1)];
  for (const def of defs) {
    const id = `${f.FixtureId}:${def.slug}`;
    const existing = await db.query.markets.findFirst({ where: eq(schema.markets.id, id) });
    if (existing) continue;

    const hashHex = termsHashHex(fromPlainTerms(def.terms));
    let marketPdaStr: string | null = null;
    let vaultPdaStr: string | null = null;
    let state: 'InPlay' | 'AwaitingRoot' | 'Settled' | 'Void' = 'AwaitingRoot';
    let winnerYes: boolean | null = null;
    let evidenceTs: number | null = null;
    let disputeUntilTs: number | null = null;

    if (!def.andTerms?.length) {
      const pda = marketPda(fromPlainTerms(def.terms));
      let acct: Awaited<ReturnType<typeof pool.account.market.fetchNullable>>;
      try {
        acct = await pool.account.market.fetchNullable(pda);
      } catch (err) {
        console.error(`[auto-market] recovery fetch failed for ${id}: ${String(err).slice(0, 120)}`);
        continue; // transient RPC failure — retry next tick
      }
      if (!acct) continue; // never existed on-chain; nothing to recover
      marketPdaStr = pda.toBase58();
      vaultPdaStr = vaultPda(pda).toBase58();
      const st = acct.state as Record<string, unknown>;
      if ('resolved' in st) {
        state = 'Settled';
        winnerYes = acct.winnerYes;
        evidenceTs = Number(acct.evidenceTs) * 1000;
        disputeUntilTs = Number(acct.disputeUntilTs) * 1000;
      } else if ('void' in st) {
        state = 'Void';
      } // else Open: fixture already started → settler drives it from AwaitingRoot
      await new Promise((r) => setTimeout(r, 500)); // RPC budget
    }

    await db.insert(schema.markets).values({
      id,
      fixtureId: f.FixtureId,
      slug: def.slug,
      marketClass: def.marketClass,
      question: def.question,
      yesLabel: def.yesLabel,
      noLabel: def.noLabel,
      termsJson: JSON.stringify(def.terms),
      termsHash: hashHex,
      andTermsJson: def.andTerms ? JSON.stringify(def.andTerms) : null,
      lockRule: def.lockRule,
      resolutionMethod: def.resolutionMethod,
      state,
      winnerYes,
      evidenceTs,
      disputeUntilTs,
      lockTs: f.StartTime - 2 * 60_000,
      resolveDeadlineTs: f.StartTime + config.resolveDeadlineMs,
      marketPda: marketPdaStr,
      vaultPda: vaultPdaStr,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`[auto-market] recovered ${id} from chain (${state})`);
  }
}

/**
 * Auto-market engine (spec §10.1). Polls the fixtures snapshot, upserts
 * fixtures, and instantiates the Class-A catalog for every upcoming covered
 * fixture — both in the DB and as on-chain pool markets. Idempotent on
 * terms_hash (the market PDA is seeded by it, and the DB id by fixture+slug).
 */
export function startAutoMarketEngine(ctx: Ctx, pool: Program<GroundtruthPool>) {
  let stopped = false;

  async function tick() {
    const fixtures = await ctx.txline.fixturesSnapshot({ startEpochDay: epochDay() - 1 });
    const covered = fixtures.filter((f) => config.competitionIds.includes(f.CompetitionId));
    const now = Date.now();

    for (const f of covered) {
      await db
        .insert(schema.fixtures)
        .values({
          fixtureId: f.FixtureId,
          competitionId: f.CompetitionId,
          competition: f.Competition,
          homeId: f.Participant1IsHome ? f.Participant1Id : f.Participant2Id,
          home: f.Participant1IsHome ? f.Participant1 : f.Participant2,
          awayId: f.Participant1IsHome ? f.Participant2Id : f.Participant1Id,
          away: f.Participant1IsHome ? f.Participant2 : f.Participant1,
          homeIsP1: f.Participant1IsHome,
          startTime: f.StartTime,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.fixtures.fixtureId,
          set: { startTime: f.StartTime, updatedAt: now },
        });

      // Only create markets for fixtures that have not kicked off yet and
      // start within the horizon (rent + RPC budget). Fixtures that already
      // started get a recovery sweep instead: if the DB was lost (fresh
      // deploy, wiped volume), catalog market rows are reconstructed from
      // their on-chain pool accounts so settlement and claims keep working.
      if (f.StartTime <= now) {
        if (f.StartTime > now - RECOVERY_WINDOW_MS) {
          await recoverFixtureMarkets(pool, f, now);
        }
        continue;
      }
      if (f.StartTime > now + config.marketHorizonMs) continue;

      // NOTE: catalog templates speak home/away in P1/P2 stat terms; when the
      // feed has P1 = away team, home/away labels must swap.
      // Template stat keys are P1/P2-based, so the names fed to the catalog
      // MUST be P1/P2 names (not venue home/away) or questions and predicates
      // could disagree when the feed lists the away side as Participant1.
      const fxInfo = { fixtureId: f.FixtureId, home: f.Participant1, away: f.Participant2 };
      // Full-game catalog + first-half O/U variants.
      const defs = [...classAMarkets(fxInfo), ...classAMarkets(fxInfo, 1)];

      for (const def of defs) {
        const id = `${f.FixtureId}:${def.slug}`;
        const existing = await db.query.markets.findFirst({
          where: eq(schema.markets.id, id),
        });
        if (existing) continue;

        const lockTs = f.StartTime - 2 * 60_000;
        const resolveDeadlineTs = f.StartTime + config.resolveDeadlineMs;
        const hashHex = termsHashHex(fromPlainTerms(def.terms));

        // Composite (multi-proof) markets stay off-chain in v1 — the pool
        // program verifies exactly one predicate.
        let marketPdaStr: string | null = null;
        let vaultPdaStr: string | null = null;
        let createTx: string | null = null;
        if (!def.andTerms?.length) {
          try {
            const res = await createMarket(pool, ctx.keeper, def.terms, {
              lockTs: Math.floor(lockTs / 1000),
              resolveDeadlineTs: Math.floor(resolveDeadlineTs / 1000),
            });
            marketPdaStr = res.market.toBase58();
            vaultPdaStr = res.vault.toBase58();
            createTx = res.signature;
            console.log(`[auto-market] created on-chain pool ${id} → ${marketPdaStr}`);
            await new Promise((r) => setTimeout(r, config.createThrottleMs));
          } catch (err) {
            // Might already exist from a previous run (PDA collision is fine).
            const existsAlready = /already in use/.test(String(err));
            if (existsAlready) {
              marketPdaStr = marketPda(fromPlainTerms(def.terms)).toBase58();
              vaultPdaStr = vaultPda(marketPda(fromPlainTerms(def.terms))).toBase58();
            } else {
              console.error(`[auto-market] on-chain create failed for ${id}: ${String(err).slice(0, 200)}`);
              continue;
            }
          }
        }

        await db.insert(schema.markets).values({
          id,
          fixtureId: f.FixtureId,
          slug: def.slug,
          marketClass: def.marketClass,
          question: def.question,
          yesLabel: def.yesLabel,
          noLabel: def.noLabel,
          termsJson: JSON.stringify(def.terms),
          termsHash: hashHex,
          andTermsJson: def.andTerms ? JSON.stringify(def.andTerms) : null,
          lockRule: def.lockRule,
          resolutionMethod: def.resolutionMethod,
          state: 'Open',
          lockTs,
          resolveDeadlineTs,
          marketPda: marketPdaStr,
          vaultPda: vaultPdaStr,
          createTx,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`[auto-market] market ${id} open (lock ${new Date(lockTs).toISOString()})`);
      }
    }
  }

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        console.error(`[auto-market] tick failed: ${String(err).slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, config.pollFixturesMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
