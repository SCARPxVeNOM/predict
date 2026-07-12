import { eq, inArray } from 'drizzle-orm';
import type { Program } from '@coral-xyz/anchor';
import { DEVNET, epochDay, type PlainTerms } from '@groundtruth/shared';
import { STAT_LABEL } from '@groundtruth/catalog';
import {
  fromPlainTerms,
  resolveMarket,
  rootPdaForBundle,
  toStatProofBundle,
  voidMarketOnChain,
  type GroundtruthPool,
} from '@groundtruth/chain';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import type { Ctx } from './txline.js';
import { bus } from './bus.js';

/**
 * Settler/keeper (spec §10.3): drives AwaitingRoot → Resolving → Settled.
 * Fetches the deciding proof from /scores/stat-validation, submits the
 * permissionless `resolve` on the pool program (which CPIs into txoracle's
 * validate_stat against the posted daily root), writes the receipt, and
 * handles the void path. Retries with backoff while the batch root is not yet
 * on-chain (RootNotAvailable).
 */
export function startSettler(ctx: Ctx, pool: Program<GroundtruthPool>) {
  let stopped = false;

  /**
   * Pick the record whose proof leaf period matches the market's scoped
   * period. NOT simply the highest seq: a match that goes to extra time or
   * penalties appends an undocumented status=100 archival record whose proof
   * reports period 100, and finished-phase records report their phase (e.g.
   * 10 for FET) — only the normalized full-totals record reports period 0.
   * Picking the wrong one makes the pool program reject with StatMismatch.
   * Cached per fixture:period (~2 min) so 20+ markets don't each re-walk.
   */
  const decidingSeqCache = new Map<string, { seq: number; at: number }>();
  async function findDecidingSeq(
    fixtureId: number,
    period: number,
    withStats: { Seq: number; StatusId?: number }[],
  ): Promise<number | null> {
    const key = `${fixtureId}:${period}`;
    const hit = decidingSeqCache.get(key);
    if (hit && Date.now() - hit.at < 120_000) return hit.seq;
    const candidates = withStats
      .filter((s) => s.StatusId === undefined || (s.StatusId >= 1 && s.StatusId <= 19))
      .sort((a, b) => b.Seq - a.Seq)
      .slice(0, 8);
    for (const c of candidates) {
      const probe = await ctx.txline.statValidation(fixtureId, c.Seq, period * 1000 + 1);
      if (probe.statToProve.period === period) {
        decidingSeqCache.set(key, { seq: c.Seq, at: Date.now() });
        return c.Seq;
      }
    }
    return null;
  }

  async function settleOne(m: typeof schema.markets.$inferSelect) {
    const fixture = await db.query.fixtures.findFirst({
      where: eq(schema.fixtures.fixtureId, m.fixtureId),
    });
    if (!fixture?.lastSeq) return;
    const terms = JSON.parse(m.termsJson) as PlainTerms;

    const snaps = await ctx.txline.scoresSnapshot(m.fixtureId);
    const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
    if (!withStats.length) return;
    const decidingSeq = await findDecidingSeq(m.fixtureId, terms.period, withStats);
    if (decidingSeq === null) return; // no period-matching record yet — retry next tick

    const val = await ctx.txline.statValidation(
      m.fixtureId,
      decidingSeq,
      terms.statAKey,
      terms.statBKey ?? undefined,
    );
    const bundle = toStatProofBundle(val);
    const { pda: rootPda, epochDay: day } = rootPdaForBundle(bundle);

    if (m.marketPda) {
      try {
        const sig = await resolveMarket(pool, ctx.keeper, m.marketPda, bundle, rootPda);
        await afterResolve(m, terms, val, decidingSeq, sig, day, rootPda.toBase58());
      } catch (err) {
        const s = String(err);
        if (/RootNotAvailable/.test(s)) {
          // Root batch not posted yet — stay in AwaitingRoot, retry next tick.
          return;
        }
        if (/EvidenceTooEarly/.test(s)) {
          // The market's lock postdates every match record (e.g. authored
          // against a stale replayed status) — no proof can ever satisfy it.
          // Void in DB now; the on-chain void + refunds happen at deadline.
          await db
            .update(schema.markets)
            .set({ state: 'Void', updatedAt: Date.now() })
            .where(eq(schema.markets.id, m.id));
          bus.emit('market', { id: m.id, state: 'Void' });
          console.log(`[settler] ${m.id} unresolvable (EvidenceTooEarly) — voided`);
          return;
        }
        if (/TimestampMismatch/.test(s)) {
          // The on-chain daily root has advanced past the period-0 record
          // (a post-match archival batch, status=100, retips the root ~5min
          // after full time), so the correctly-scoped proof no longer
          // validates and the only accepted record has the wrong period.
          // Within the settling window this can be transient (root mid-post)
          // — retry; once the match is well finished it is permanent, so
          // void for refund. Prompt settlement (findDecidingSeq) normally
          // resolves before the archival record ever posts.
          if (Date.now() > fixture.startTime + 2.5 * 3600_000) {
            await db
              .update(schema.markets)
              .set({ state: 'Void', updatedAt: Date.now() })
              .where(eq(schema.markets.id, m.id));
            bus.emit('market', { id: m.id, state: 'Void' });
            console.log(`[settler] ${m.id} unprovable (root advanced past period-0 record) — voided`);
          }
          return;
        }
        throw err;
      }
    } else {
      // Composite / receipt-only market: keeper verifies each leg read-only.
      await afterResolve(m, terms, val, decidingSeq, null, day, rootPda.toBase58());
    }
  }

  /**
   * Regenerate the receipt for an already-Settled market that lost its row
   * (DB recovery reconstructs markets from chain, but receipts only exist in
   * the DB). Same proof path as live settling, no on-chain write.
   */
  async function backfillReceipt(m: typeof schema.markets.$inferSelect) {
    const terms = JSON.parse(m.termsJson) as PlainTerms;
    const snaps = await ctx.txline.scoresSnapshot(m.fixtureId);
    const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
    if (!withStats.length) return;
    const decidingSeq = await findDecidingSeq(m.fixtureId, terms.period, withStats);
    if (decidingSeq === null) return;
    const val = await ctx.txline.statValidation(
      m.fixtureId,
      decidingSeq,
      terms.statAKey,
      terms.statBKey ?? undefined,
    );
    const bundle = toStatProofBundle(val);
    const { pda: rootPda, epochDay: day } = rootPdaForBundle(bundle);
    await afterResolve(m, terms, val, decidingSeq, m.resolveTx, day, rootPda.toBase58(), true);
    console.log(`[settler] receipt backfilled for ${m.id}`);
  }

  async function afterResolve(
    m: typeof schema.markets.$inferSelect,
    terms: PlainTerms,
    val: Awaited<ReturnType<Ctx['txline']['statValidation']>>,
    decidingSeq: number,
    resolveTx: string | null,
    rootDay: number,
    rootPda: string,
    quiet = false,
  ) {
    const now = Date.now();

    // Compute the outcome locally for the receipt text (the chain already
    // verified it for pool markets).
    const a = val.statToProve.value;
    const b = val.statToProve2?.value ?? 0;
    const combined = terms.op === 'Add' ? a + b : terms.op === 'Subtract' ? a - b : a;
    const cmp = terms.predicate.comparison;
    const raw =
      cmp === 'GreaterThan'
        ? combined > terms.predicate.threshold
        : cmp === 'LessThan'
          ? combined < terms.predicate.threshold
          : combined === terms.predicate.threshold;
    let winnerYes = raw !== terms.negation;

    // Composite markets (e.g. BTTS): AND every additional proven leg. Each
    // leg's stat is fetched as its own proof so the receipt stays re-checkable.
    const andTerms = m.andTermsJson ? (JSON.parse(m.andTermsJson) as PlainTerms[]) : [];
    const legResults: { terms: PlainTerms; value: number; pass: boolean }[] = [];
    for (const leg of andTerms) {
      const legVal = await ctx.txline.statValidation(
        m.fixtureId,
        decidingSeq,
        leg.statAKey,
        leg.statBKey ?? undefined,
      );
      const la = legVal.statToProve.value;
      const lb = legVal.statToProve2?.value ?? 0;
      const lc = leg.op === 'Add' ? la + lb : leg.op === 'Subtract' ? la - lb : la;
      const lcmp = leg.predicate.comparison;
      const lraw =
        lcmp === 'GreaterThan'
          ? lc > leg.predicate.threshold
          : lcmp === 'LessThan'
            ? lc < leg.predicate.threshold
            : lc === leg.predicate.threshold;
      const pass = lraw !== leg.negation;
      legResults.push({ terms: leg, value: lc, pass });
      winnerYes = winnerYes && pass;
    }

    const statAName = STAT_LABEL[terms.statAKey % 1000] ?? `stat ${terms.statAKey}`;
    const statBName =
      terms.statBKey !== null ? (STAT_LABEL[terms.statBKey % 1000] ?? `stat ${terms.statBKey}`) : null;
    const exprText = statBName
      ? `${statAName} (${a}) ${terms.op === 'Add' ? '+' : '−'} ${statBName} (${b}) = ${combined}`
      : `${statAName} = ${a}`;
    const cmpText = cmp === 'GreaterThan' ? '>' : cmp === 'LessThan' ? '<' : '=';
    const legText = legResults.length
      ? ` AND ${legResults
          .map(
            (l) =>
              `${STAT_LABEL[l.terms.statAKey % 1000] ?? `stat ${l.terms.statAKey}`} = ${l.value} (${l.pass ? 'met' : 'not met'})`,
          )
          .join(', ')}`
      : '';
    const explanation =
      `${winnerYes ? 'YES' : 'NO'} paid out because ${exprText} ${raw ? '' : 'NOT '}` +
      `${cmpText} ${terms.predicate.threshold}${legText}, proven against the TxLINE scores root for epoch day ${rootDay}.`;

    await db.insert(schema.receipts).values({
      marketId: m.id,
      fixtureId: m.fixtureId,
      decidingSeq,
      evidenceTs: val.ts,
      provenJson: JSON.stringify({
        statA: val.statToProve,
        statB: val.statToProve2 ?? null,
        predicate: terms.predicate,
        op: terms.op,
        negation: terms.negation,
        legs: legResults.map((l) => ({ terms: l.terms, value: l.value, pass: l.pass })),
      }),
      rootDay,
      rootPda,
      resolveTx,
      proofJson: JSON.stringify(val),
      explanation,
      winnerYes,
      createdAt: now,
    }).onConflictDoNothing();

    await db
      .update(schema.markets)
      .set({
        state: 'Settled',
        winnerYes,
        evidenceTs: val.ts,
        resolveTx,
        updatedAt: now,
      })
      .where(eq(schema.markets.id, m.id));

    if (!quiet) {
      await db.insert(schema.notifications).values({
        wallet: null,
        kind: 'market_resolved',
        payloadJson: JSON.stringify({
          marketId: m.id,
          winnerYes,
          explorer: resolveTx ? DEVNET.explorerTxUrl(resolveTx) : null,
        }),
        createdAt: now,
      });
      bus.emit('market', { id: m.id, state: 'Settled', winnerYes });
      console.log(`[settler] settled ${m.id}: ${winnerYes ? 'YES' : 'NO'} — ${explanation}`);
    }
  }

  async function voidOne(m: typeof schema.markets.$inferSelect) {
    if (m.marketPda && Date.now() >= m.resolveDeadlineTs) {
      try {
        await voidMarketOnChain(pool, ctx.keeper, m.marketPda);
      } catch (err) {
        if (!/MarketNotOpen/.test(String(err))) throw err;
      }
    }
    await db
      .update(schema.markets)
      .set({ state: 'Void', updatedAt: Date.now() })
      .where(eq(schema.markets.id, m.id));
    bus.emit('market', { id: m.id, state: 'Void' });
  }

  const loop = async () => {
    while (!stopped) {
      try {
        // Time-based lock sweep: records only arrive while something happens
        // on the pitch, so Open→Locked must also fire on the clock.
        const openMarkets = await db.query.markets.findMany({
          where: inArray(schema.markets.state, ['Open']),
        });
        for (const m of openMarkets) {
          if (Date.now() >= m.lockTs) {
            await db
              .update(schema.markets)
              .set({ state: 'Locked', updatedAt: Date.now() })
              .where(eq(schema.markets.id, m.id));
            bus.emit('market', { id: m.id, state: 'Locked' });
          }
        }

        const pending = await db.query.markets.findMany({
          where: inArray(schema.markets.state, ['AwaitingRoot', 'Resolving']),
        });
        for (const m of pending) {
          try {
            await settleOne(m);
          } catch (err) {
            console.error(`[settler] ${m.id}: ${String(err).slice(0, 300)}`);
          }
        }
        // Receipt backfill: settled markets recovered from chain have no
        // receipt row yet — regenerate a few per tick (proof-API budget).
        const settledMarkets = await db.query.markets.findMany({
          where: inArray(schema.markets.state, ['Settled']),
        });
        const withReceipts = new Set(
          (await db.query.receipts.findMany()).map((r) => r.marketId),
        );
        let backfilled = 0;
        for (const m of settledMarkets) {
          if (backfilled >= 3) break;
          if (!m.marketPda || m.fixtureId <= 0 || withReceipts.has(m.id)) continue;
          try {
            await backfillReceipt(m);
            backfilled += 1;
          } catch (err) {
            console.error(`[settler] receipt backfill ${m.id}: ${String(err).slice(0, 200)}`);
          }
        }

        // Void overdue markets (root never came / abandoned).
        const overdue = await db.query.markets.findMany({
          where: inArray(schema.markets.state, ['Open', 'Locked', 'InPlay', 'AwaitingRoot', 'Void']),
        });
        for (const m of overdue) {
          const pastDeadline = Date.now() >= m.resolveDeadlineTs;
          if (m.state === 'Void' || pastDeadline) {
            try {
              await voidOne(m);
            } catch (err) {
              console.error(`[settler] void ${m.id}: ${String(err).slice(0, 200)}`);
            }
          }
        }
      } catch (err) {
        console.error('[settler] tick failed', String(err).slice(0, 300));
      }
      await new Promise((r) => setTimeout(r, config.settlerTickMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
