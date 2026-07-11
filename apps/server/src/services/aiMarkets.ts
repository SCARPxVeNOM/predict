import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Program } from '@coral-xyz/anchor';
import type { PlainTerms } from '@groundtruth/shared';
import { FINISHED_STATUSES, SOCCER_STATUS } from '@groundtruth/catalog';
import { createMarket, fromPlainTerms, termsHashHex, type GroundtruthPool } from '@groundtruth/chain';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { geminiGenerate } from './gemini.js';
import type { Ctx } from './txline.js';

/**
 * Tournament market author (Predictions section).
 *
 * The LLM only AUTHORS candidate markets — it never resolves anything and can
 * only reference teams/players that exist in the real bracket/scorer data;
 * everything else is rejected by the schema below. Tiers:
 *   - chain: decided by a future fixture's on-chain proof (champion, finalist)
 *   - feed:  decided from aggregated real PlayerStats (top scorer)
 * FIFA-voted awards (Golden Ball…) are excluded by design — nothing can prove
 * them (user decision 2026-07-10).
 */

// v1 allows only rules whose settlement path is fully wired: champion
// (attaches to the final's on-chain proof) and top-scorer (feed aggregate).
// Anything else an LLM invents is rejected here — a wrong market cannot ship.
// Champion is the ONLY sound tournament-level rule: it settles by the final
// match's on-chain proof. Award rules (top scorer, fair play, clean sheets,
// team goals) were removed 2026-07-11 — they aggregate the WHOLE tournament,
// but TxLINE's coverage window can't see the group stage, so no market on
// them can settle truthfully.
const ruleSchema = z.object({ kind: z.literal('champion'), teamId: z.number().int() });

/** Provable per-fixture stat grammar (spec §3): base keys 1–8, optional
 * period scope, one- or two-stat predicate with Add/Subtract. Anything the
 * LLM proposes outside this grammar cannot exist on-chain and is rejected. */
const STAT_FAMILY: Record<number, 'goals' | 'yellows' | 'reds' | 'corners'> = {
  1: 'goals', 2: 'goals', 3: 'yellows', 4: 'yellows',
  5: 'reds', 6: 'reds', 7: 'corners', 8: 'corners',
};
const FAMILY_MAX_THRESHOLD: Record<string, number> = {
  goals: 8, yellows: 12, reds: 4, corners: 20,
};

// Tolerant on FORM (models drop null keys, overshoot label lengths — we
// normalize), strict on SUBSTANCE (keys, period, comparison, threshold —
// anything off-grammar is rejected because it cannot exist on-chain).
const liveProposalSchema = z.object({
  markets: z
    .array(
      z.object({
        slug: z
          .string()
          .min(3)
          .transform((s) =>
            s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50),
          ),
        question: z.string().min(8).transform((s) => s.slice(0, 140)),
        yesLabel: z.string().min(2).transform((s) => s.slice(0, 28)),
        noLabel: z.string().min(2).transform((s) => s.slice(0, 28)),
        fixtureId: z.number().int(),
        period: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        statAKey: z.number().int().min(1).max(8),
        statBKey: z
          .number()
          .int()
          .min(1)
          .max(8)
          .nullish()
          .transform((v) => v ?? null),
        comparison: z.enum(['GreaterThan', 'LessThan', 'EqualTo']),
        threshold: z.number().int().min(0).max(20),
        op: z
          .enum(['Add', 'Subtract'])
          .nullish()
          .transform((v) => v ?? null),
        rationale: z
          .string()
          .nullish()
          .transform((s) => (s ?? '').slice(0, 240)),
      }),
    )
    .max(16),
});

const proposalSchema = z.object({
  markets: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]{3,50}$/),
        question: z.string().min(8).max(120),
        yesLabel: z.string().min(2).max(24),
        noLabel: z.string().min(2).max(24),
        tier: z.enum(['chain', 'feed']),
        rule: ruleSchema,
        rationale: z.string().max(240),
      }),
    )
    .max(12),
});
export type TournamentRule = z.infer<typeof ruleSchema>;

interface AliveTeam {
  teamId: number;
  name: string;
}

/**
 * Is this match over? Trust a FINISHED status, but ALSO trust the clock: feed
 * statuses can lag or regress (replayed records), and no soccer match runs
 * four hours — a fixture that kicked off >4h ago with a recorded score is
 * done, whatever the status column says. Keeps eliminated teams out of the
 * bracket even when the status is wrong.
 */
function fixtureDone(
  f: { statusId: number | null; startTime: number; scoreJson: string | null },
  now = Date.now(),
): boolean {
  if (f.statusId !== null && FINISHED_STATUSES.has(f.statusId)) return true;
  return f.startTime < now - 4 * 3600_000 && !!f.scoreJson;
}

export function startAiMarketAuthor(ctx: Ctx, pool: Program<GroundtruthPool>) {
  let stopped = false;

  /**
   * Fixtures that finished OUTSIDE the indexer's hydration window (e.g. before
   * a fresh deployment) keep a stale/null statusId forever — the SSE stream
   * only carries new records. Pull their final snapshot so bracket state,
   * scorers and aggregates are computed from reality.
   */
  async function refreshStaleFixtures(): Promise<void> {
    const fixtures = await db.query.fixtures.findMany();
    const stale = fixtures.filter(
      (f) =>
        f.competitionId === 72 &&
        f.startTime < Date.now() - 3 * 3600_000 &&
        !(f.statusId !== null && FINISHED_STATUSES.has(f.statusId)),
    );
    for (const f of stale) {
      try {
        const snaps = await ctx.txline.scoresSnapshot(f.fixtureId);
        if (!snaps.length) continue;
        const statusRecs = snaps.filter(
          (s) => s.StatusId !== undefined && s.StatusId >= 1 && s.StatusId <= 19,
        );
        const lastStatus = statusRecs.length
          ? statusRecs.reduce((a, b) => (b.Seq > a.Seq ? b : a))
          : null;
        const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
        const lastStats = withStats.length
          ? withStats.reduce((a, b) => (b.Seq > a.Seq ? b : a))
          : null;
        const withScore = snaps.filter((s) => s.Score);
        const lastScore = withScore.length
          ? withScore.reduce((a, b) => (b.Seq > a.Seq ? b : a))
          : null;
        if (!lastStatus && !lastStats && !lastScore) continue;
        await db
          .update(schema.fixtures)
          .set({
            ...(lastStatus ? { statusId: lastStatus.StatusId } : {}),
            ...(lastStats ? { statsJson: JSON.stringify(lastStats.Stats) } : {}),
            ...(lastScore ? { scoreJson: JSON.stringify(lastScore.Score) } : {}),
            updatedAt: Date.now(),
          })
          .where(eq(schema.fixtures.fixtureId, f.fixtureId));
        console.log(
          `[ai-markets] refreshed stale fixture ${f.fixtureId} → status ${lastStatus?.StatusId ?? '?'}`,
        );
      } catch {
        /* snapshot unavailable — try again next tick */
      }
    }
  }

  /** Winners of finished fixtures + participants of unfinished ones. */
  async function aliveTeams(): Promise<AliveTeam[]> {
    const fixtures = await db.query.fixtures.findMany();
    const wc = fixtures.filter((f) => f.competitionId === 72);
    const alive = new Map<number, string>();
    for (const f of wc) {
      const finished = fixtureDone(f);
      if (!finished) {
        alive.set(f.homeId, f.home);
        alive.set(f.awayId, f.away);
      } else if (f.scoreJson) {
        try {
          const s = JSON.parse(f.scoreJson) as {
            Participant1?: { Total?: { Goals?: number } };
            Participant2?: { Total?: { Goals?: number } };
          };
          const g1 = s.Participant1?.Total?.Goals ?? 0;
          const g2 = s.Participant2?.Total?.Goals ?? 0;
          if (g1 !== g2) {
            const p1Won = g1 > g2;
            const winnerIsHome = f.homeIsP1 ? p1Won : !p1Won;
            alive.set(winnerIsHome ? f.homeId : f.awayId, winnerIsHome ? f.home : f.away);
          }
        } catch {
          /* ignore */
        }
      }
    }
    return [...alive.entries()].map(([teamId, name]) => ({ teamId, name }));
  }

  /** Aggregate real per-match PlayerStats into tournament scorer standings. */
  async function updateScorers(): Promise<void> {
    const fixtures = await db.query.fixtures.findMany();
    const finished = fixtures.filter((f) => f.competitionId === 72 && fixtureDone(f));
    const totals = new Map<number, { goals: number; teamId: number; team: string; name?: string }>();
    for (const f of finished) {
      try {
        const snaps = await ctx.txline.scoresSnapshot(f.fixtureId);
        // Backfill the final stat map for fixtures indexed before stats_json
        // existed — team aggregates (fair play, clean sheets) need it.
        if (!f.statsJson) {
          const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length);
          if (withStats.length) {
            const lastStats = withStats.reduce((a, b) => (b.Seq > a.Seq ? b : a));
            await db
              .update(schema.fixtures)
              .set({ statsJson: JSON.stringify(lastStats.Stats) })
              .where(eq(schema.fixtures.fixtureId, f.fixtureId));
          }
        }
        const withPs = snaps.filter((s) => s.PlayerStats);
        if (!withPs.length) continue;
        const last = withPs.reduce((a, b) => (b.Seq > a.Seq ? b : a));
        // Real lineup shape (verified on fixture 18209181): Lineups[] is a
        // team block { normativeId, lineups: [{ player: { normativeId,
        // preferredName: "Last, First" } }] }.
        const names = new Map<number, string>();
        for (const s of snaps) {
          for (const teamBlock of (s.Lineups as
            | { lineups?: { player?: { normativeId?: number; preferredName?: string } }[] }[]
            | undefined) ?? []) {
            for (const slot of teamBlock.lineups ?? []) {
              const pid = slot.player?.normativeId;
              const raw = slot.player?.preferredName;
              if (pid && raw) {
                const name = raw.includes(', ')
                  ? raw.split(', ').reverse().join(' ')
                  : raw;
                names.set(pid, name);
              }
            }
          }
        }
        const sides: ['Participant1' | 'Participant2', number, string][] = [
          ['Participant1', f.homeIsP1 ? f.homeId : f.awayId, f.homeIsP1 ? f.home : f.away],
          ['Participant2', f.homeIsP1 ? f.awayId : f.homeId, f.homeIsP1 ? f.away : f.home],
        ];
        for (const [side, teamId, team] of sides) {
          const stats = last.PlayerStats?.[side] ?? {};
          for (const [pid, st] of Object.entries(stats)) {
            const goals = (st as { goals?: number }).goals ?? 0;
            if (!goals) continue;
            const cur = totals.get(Number(pid)) ?? { goals: 0, teamId, team };
            cur.goals += goals;
            cur.name = names.get(Number(pid)) ?? cur.name;
            totals.set(Number(pid), cur);
          }
        }
      } catch {
        /* pruned/unavailable snapshot — partial standings are still honest */
      }
    }
    const now = Date.now();
    for (const [playerId, t] of totals) {
      await db
        .insert(schema.scorers)
        .values({
          playerId,
          name: t.name ?? null,
          teamId: t.teamId,
          team: t.team,
          goals: t.goals,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.scorers.playerId,
          set: { goals: t.goals, name: t.name ?? null, updatedAt: now },
        });
    }
  }

  // NOTE (user correction 2026-07-11): tournament AWARD markets (Golden Boot,
  // Fair Play, most clean sheets, most team goals) were removed. They are
  // whole-tournament aggregates, but TxLINE's coverage window only reaches
  // back ~2 weeks — we cannot see the group stage, so no data source we have
  // can settle them truthfully. Only champion (decided by the final's proof)
  // and per-fixture markets are sound.
  function deterministicProposals(teams: AliveTeam[]): z.infer<typeof proposalSchema>['markets'] {
    const out: z.infer<typeof proposalSchema>['markets'] = [];
    for (const t of teams.slice(0, 8)) {
      out.push({
        slug: `champion-${t.teamId}`,
        question: `${t.name} to win the World Cup?`,
        yesLabel: `${t.name} champion`,
        noLabel: 'Any other team',
        tier: 'chain',
        rule: { kind: 'champion', teamId: t.teamId },
        rationale: `${t.name} is still alive in the bracket; decided by the final's on-chain match proof.`,
      });
    }
    return out;
  }

  async function aiProposals(
    teams: AliveTeam[],
    existingSlugs: string[],
  ): Promise<z.infer<typeof proposalSchema>['markets']> {
    const prompt = `You author prediction markets for the remaining FIFA World Cup 2026 tournament. You are a PARSER of the real TxLINE bracket data below — every market must follow from it.
STRICT RULES:
- Output ONLY JSON matching: {"markets":[{"slug","question","yesLabel","noLabel","tier","rule","rationale"}]}
- ONLY tier "chain" with rule {"kind":"champion","teamId":N} — resolvable purely from the final's match result.
- teamId MUST be from this list of teams still alive: ${JSON.stringify(teams)}
- NEVER propose tournament award markets (Golden Boot, Golden Ball, Fair Play, top scorer, most goals): the data feed's coverage window cannot see the whole tournament, so nothing can settle them truthfully.
- Skip slugs already used: ${JSON.stringify(existingSlugs)}
- Max 8 markets. Questions punchy, ≤100 chars, and MUST name the team.`;
    const text = await geminiGenerate(prompt);
    if (!text) return [];
    try {
      let raw: unknown = JSON.parse(text);
      if (Array.isArray(raw)) raw = { markets: raw };
      const parsed = proposalSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | ');
        console.error(`[ai-markets] proposal rejected by schema: ${issues}\n  raw: ${text.slice(0, 400)}`);
        return [];
      }
      return parsed.data.markets;
    } catch {
      console.error(`[ai-markets] non-JSON model output discarded: ${text.slice(0, 300)}`);
      return [];
    }
  }

  /**
   * AI-authored LIVE (per-fixture) markets: Gemini proposes predicates inside
   * the provable stat grammar for upcoming WC fixtures; every proposal is
   * validated (grammar, families, thresholds, real fixture, terms-hash
   * dedupe) and then created as a real on-chain pool.
   */
  /**
   * In-play author (user redesign 2026-07-10): the AI acts ONLY during live
   * matches, parsing the real live TxLINE state — never on a blind timer.
   * One Gemini call per match phase (kickoff / half-time / ~60'), and every
   * proposed line must be genuinely uncertain given the live stats (balance
   * guard), the way a bookmaker centres in-play lines on the current state.
   */
  const firedPhases = new Map<number, Set<'kickoff' | 'ht' | 'h2'>>();

  function phaseFor(statusId: number, clockSeconds: number | null): 'kickoff' | 'ht' | 'h2' | null {
    if (statusId === SOCCER_STATUS.H1) return 'kickoff';
    if (statusId === SOCCER_STATUS.HT) return 'ht';
    // Fire the second-half call around the hour mark, not right at restart.
    if (statusId === SOCCER_STATUS.H2 && (clockSeconds ?? 0) >= 55 * 60) return 'h2';
    return null;
  }

  /** Expected full-game production per stat family (both teams combined). */
  const FAMILY_RATE: Record<string, number> = { goals: 2.6, yellows: 4.5, reds: 0.3, corners: 9.5 };
  /** How far a line may sit from the live-expected final value and still be a
   * real two-sided market. Kills "over 0.5 yellow cards"-style free money. */
  const FAMILY_BAND: Record<string, number> = { goals: 1.25, yellows: 1.5, reds: 0.75, corners: 3.5 };

  /** Returns a rejection reason, or null when the line is fair and undecided.
   * Also used pre-match (statusId NS, empty stats, clock 0) — there every
   * period is still open and expectations run from the base rates. */
  function inPlayGuard(
    p: { period: 0 | 1 | 2; statAKey: number; statBKey: number | null; comparison: string; threshold: number; op: string | null },
    stats: Record<string, number>,
    statusId: number,
    clockSeconds: number,
  ): string | null {
    if (p.period === 1 && statusId !== SOCCER_STATUS.NS) return 'first half already known in-play';
    const fam = STAT_FAMILY[p.statAKey]!;
    const curA = stats[String(p.period * 1000 + p.statAKey)] ?? 0;
    const curB = p.statBKey === null ? 0 : stats[String(p.period * 1000 + p.statBKey)] ?? 0;
    const cur = p.op === 'Add' ? curA + curB : p.op === 'Subtract' ? curA - curB : curA;

    // Monotonic stats: reject anything the live state has already decided.
    if (p.op !== 'Subtract') {
      if (p.comparison === 'GreaterThan' && cur > p.threshold) return `already decided (value ${cur})`;
      if (p.comparison === 'LessThan' && cur >= p.threshold) return `already decided (value ${cur})`;
      if (p.comparison === 'EqualTo' && cur > p.threshold) return `already impossible (value ${cur})`;
    }

    const remaining =
      p.period === 1
        ? 2700
        : p.period === 2 && statusId <= SOCCER_STATUS.HT
          ? 2700
          : Math.max(0, 5400 - clockSeconds);
    const rate = p.op === 'Add' ? FAMILY_RATE[fam]! : p.op === 'Subtract' ? 0 : FAMILY_RATE[fam]! / 2;
    const expectedFinal = cur + rate * (remaining / 5400);
    const line =
      p.threshold + (p.comparison === 'GreaterThan' ? 0.5 : p.comparison === 'LessThan' ? -0.5 : 0);
    if (Math.abs(line - expectedFinal) > FAMILY_BAND[fam]!) {
      return `unbalanced line ${line} vs live-expected ${expectedFinal.toFixed(2)}`;
    }
    return null;
  }

  async function liveAiTick() {
    const now = Date.now();
    // Only matches that are actually live right now. The freshness checks
    // matter: during snapshot hydration after a restart the indexer replays
    // OLD records, and a transient stale "H2" status once made the author
    // mint an in-play market after full time — its lock postdated every
    // match record, so it could never resolve (EvidenceTooEarly).
    const live = (await db.query.fixtures.findMany()).filter(
      (f) =>
        f.competitionId === 72 &&
        f.statusId !== null &&
        [SOCCER_STATUS.H1, SOCCER_STATUS.HT, SOCCER_STATUS.H2].includes(f.statusId as 2 | 3 | 4) &&
        // A soccer match is over well within 2.5h of kickoff.
        now < f.startTime + 150 * 60_000 &&
        // The feed must be actively producing records (60s delay + margin) —
        // rules out hydration replays and dead feeds.
        f.lastTs !== null &&
        now - f.lastTs < 10 * 60_000,
    );
    if (!live.length) return;

    const allMarkets = await db.query.markets.findMany();
    const existingHashes = new Set(allMarkets.map((m) => m.termsHash));
    const perFixtureAiCount = new Map<number, number>();
    for (const m of allMarkets) {
      if (m.origin === 'ai' && m.fixtureId > 0) {
        perFixtureAiCount.set(m.fixtureId, (perFixtureAiCount.get(m.fixtureId) ?? 0) + 1);
      }
    }

    for (const f of live) {
      const phase = phaseFor(f.statusId!, f.clockSeconds);
      if (!phase) continue;
      const fired = firedPhases.get(f.fixtureId) ?? new Set();
      if (fired.has(phase)) continue;
      if (!f.statsJson) continue; // no live data = no market
      fired.add(phase);
      firedPhases.set(f.fixtureId, fired);

      const stats = JSON.parse(f.statsJson) as Record<string, number>;
      const clock = f.clockSeconds ?? (phase === 'kickoff' ? 1200 : phase === 'ht' ? 2700 : 3600);
      const teamP1 = f.homeIsP1 ? f.home : f.away;
      const teamP2 = f.homeIsP1 ? f.away : f.home;
      const liveState = {
        fixtureId: f.fixtureId,
        teamP1,
        teamP2,
        minute: Math.floor(clock / 60),
        phase,
        liveStats: {
          [`${teamP1} goals`]: stats['1'] ?? 0,
          [`${teamP2} goals`]: stats['2'] ?? 0,
          [`${teamP1} yellow cards`]: stats['3'] ?? 0,
          [`${teamP2} yellow cards`]: stats['4'] ?? 0,
          [`${teamP1} red cards`]: stats['5'] ?? 0,
          [`${teamP2} red cards`]: stats['6'] ?? 0,
          [`${teamP1} corners`]: stats['7'] ?? 0,
          [`${teamP2} corners`]: stats['8'] ?? 0,
        },
        existingQuestions: allMarkets
          .filter((m) => m.fixtureId === f.fixtureId)
          .map((m) => m.question),
      };

      const prompt = `You author IN-PLAY prediction markets for a live FIFA World Cup 2026 match, like a bookmaker's live desk. You are a PARSER of the live data below — every market must follow from it.
STRICT GRAMMAR (anything else is rejected):
- statAKey/statBKey are base keys: 1=teamP1 goals, 2=teamP2 goals, 3=teamP1 yellow cards, 4=teamP2 yellows, 5=teamP1 reds, 6=teamP2 reds, 7=teamP1 corners, 8=teamP2 corners.
- period: 0=full game (final totals) or 2=second half only. NEVER 1.
- predicate: value(statA [op statB]) comparison threshold. op is "Add"|"Subtract"|null. comparison "GreaterThan"|"LessThan"|"EqualTo". Integer threshold.
- When op is set, both keys MUST be the same stat family. Over X.5 = GreaterThan floor(X.5).
BALANCE RULE: the line must be genuinely uncertain GIVEN the live stats — pick thresholds near what the final value will plausibly be from here (e.g. at 1-0 in minute ${Math.floor(clock / 60)}, full-game total goals over 2.5 is fair; over 0.5 is not a market). One-sided lines are rejected.
Output ONLY JSON: {"markets":[{"slug","question","yesLabel","noLabel","fixtureId","period","statAKey","statBKey","comparison","threshold","op","rationale"}]}
LIVE MATCH STATE: ${JSON.stringify(liveState)}
fixtureId MUST be ${f.fixtureId}. Use the exact team names in questions and mention the current score/minute context in the rationale. Do NOT duplicate existingQuestions. Max 3 markets.`;

      const text = await geminiGenerate(prompt);
      if (!text) continue;
      let proposals: z.infer<typeof liveProposalSchema>['markets'];
      try {
        let raw: unknown = JSON.parse(text);
        // Models sometimes return the bare array instead of {markets:[...]}.
        if (Array.isArray(raw)) raw = { markets: raw };
        const parsed = liveProposalSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(' | ');
          console.error(`[ai-markets] in-play proposals rejected: ${issues}\n  raw: ${text.slice(0, 400)}`);
          continue;
        }
        proposals = parsed.data.markets;
      } catch {
        console.error(`[ai-markets] in-play proposals: non-JSON output discarded: ${text.slice(0, 300)}`);
        continue;
      }

      for (const p of proposals) {
        if (p.fixtureId !== f.fixtureId) continue;
        if (p.slug.length < 3) continue; // degenerate after normalization
        if ((perFixtureAiCount.get(p.fixtureId) ?? 0) >= 8) continue; // rent budget
        const famA = STAT_FAMILY[p.statAKey]!;
        if (p.op !== null) {
          if (p.statBKey === null) continue;
          if (STAT_FAMILY[p.statBKey] !== famA) continue; // cross-family = nonsense
          if (p.statAKey === p.statBKey) continue;
        } else if (p.statBKey !== null) {
          continue;
        }
        if (p.threshold > FAMILY_MAX_THRESHOLD[famA]!) continue;
        // Question must reference a real entity of this fixture or its stat family.
        const q = p.question.toLowerCase();
        const familyWord = { goals: 'goal', yellows: 'card', reds: 'card', corners: 'corner' }[famA];
        if (!q.includes(teamP1.toLowerCase()) && !q.includes(teamP2.toLowerCase()) && !q.includes(familyWord)) continue;
        // "total/combined/both teams" wording must actually sum both teams —
        // a single-team predicate under a "total" question is a wrong market.
        if (/\btotal\b|\bcombined\b|\bboth teams\b/.test(q) && p.op !== 'Add') continue;
        // The bookmaker guard: decided or one-sided lines never ship.
        const rejection = inPlayGuard(p, stats, f.statusId!, clock);
        if (rejection) {
          console.log(`[ai-markets] in-play guard rejected ${p.slug}: ${rejection}`);
          continue;
        }

        // Period scope lives in the offset stat key; on-chain terms.period
        // must be 0 to match the proof leaf (see catalog templates note).
        const terms: PlainTerms = {
          fixtureId: p.fixtureId,
          period: 0,
          statAKey: p.period * 1000 + p.statAKey,
          statBKey: p.statBKey === null ? null : p.period * 1000 + p.statBKey,
          predicate: { threshold: p.threshold, comparison: p.comparison },
          op: p.op,
          negation: false,
        };
        const hashHex = termsHashHex(fromPlainTerms(terms));
        if (existingHashes.has(hashHex)) continue; // identical predicate exists

        // Short in-play betting window; the 60s feed delay is why it is not
        // longer and why there are no "next event" markets at all.
        const lockTs = now + 8 * 60_000;
        let marketPda: string | null = null;
        let vaultPda: string | null = null;
        let createTx: string | null = null;
        try {
          const res = await createMarket(pool, ctx.keeper, terms, {
            lockTs: Math.floor(lockTs / 1000),
            resolveDeadlineTs: Math.floor((f.startTime + config.resolveDeadlineMs) / 1000),
          });
          marketPda = res.market.toBase58();
          vaultPda = res.vault.toBase58();
          createTx = res.signature;
          await new Promise((r) => setTimeout(r, config.createThrottleMs));
        } catch (err) {
          console.error(`[ai-markets] in-play pool create failed (${p.slug}): ${String(err).slice(0, 150)}`);
          continue;
        }

        await db
          .insert(schema.markets)
          .values({
            id: `${p.fixtureId}:ai-${p.slug}`,
            fixtureId: p.fixtureId,
            slug: `ai-${p.slug}`,
            marketClass: 'A',
            question: p.question,
            yesLabel: p.yesLabel,
            noLabel: p.noLabel,
            termsJson: JSON.stringify(terms),
            termsHash: hashHex,
            lockRule: 'in-play',
            resolutionMethod:
              'Settled on-chain: Merkle proof of the match stat verified against the TxLINE daily scores root (authored in-play from the live 60s-delayed feed)',
            state: 'Open',
            lockTs,
            resolveDeadlineTs: f.startTime + config.resolveDeadlineMs,
            marketPda,
            vaultPda,
            createTx,
            origin: 'ai',
            rationale: p.rationale,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        existingHashes.add(hashHex);
        perFixtureAiCount.set(p.fixtureId, (perFixtureAiCount.get(p.fixtureId) ?? 0) + 1);
        console.log(`[ai-markets] in-play market authored ${p.fixtureId}:ai-${p.slug} — ${p.question}`);
      }
    }
  }

  /**
   * Pre-match AI specials (user request 2026-07-11): for every upcoming
   * covered fixture the AI authors a few markets BEYOND the fixed catalog —
   * cards lines, corner matchups, half-scoped totals — grounded in the
   * knockout-form stats we actually hold, strictly inside the provable
   * grammar. Lifecycle is fully automated and identical to catalog markets:
   * real on-chain pool, lock 2min before kickoff, Merkle-proof settlement,
   * void+refund after the deadline, auto-archive off the Live page.
   */
  const prematchFired = new Set<number>();

  async function prematchAiTick() {
    const now = Date.now();
    const fixtures = await db.query.fixtures.findMany();
    const upcoming = fixtures.filter(
      (f) =>
        f.competitionId === 72 &&
        (f.statusId === null || f.statusId === SOCCER_STATUS.NS) &&
        f.startTime > now + 30 * 60_000 &&
        f.startTime < now + 48 * 3600_000,
    );
    if (!upcoming.length) return;

    const allMarkets = await db.query.markets.findMany();
    const existingHashes = new Set(allMarkets.map((m) => m.termsHash));

    // Per-team knockout form from finished covered fixtures — real grounding
    // for the lines the model proposes.
    const done = fixtures.filter((f) => f.competitionId === 72 && fixtureDone(f) && f.statsJson);
    const form = new Map<
      number,
      { team: string; matches: number; goalsFor: number; goalsAgainst: number; yellows: number; corners: number }
    >();
    for (const f of done) {
      const stats = JSON.parse(f.statsJson!) as Record<string, number>;
      const p1Id = f.homeIsP1 ? f.homeId : f.awayId;
      const p2Id = f.homeIsP1 ? f.awayId : f.homeId;
      const p1Name = f.homeIsP1 ? f.home : f.away;
      const p2Name = f.homeIsP1 ? f.away : f.home;
      const upd = (id: number, team: string, gf: number, ga: number, y: number, c: number) => {
        const t = form.get(id) ?? { team, matches: 0, goalsFor: 0, goalsAgainst: 0, yellows: 0, corners: 0 };
        t.matches += 1;
        t.goalsFor += gf;
        t.goalsAgainst += ga;
        t.yellows += y;
        t.corners += c;
        form.set(id, t);
      };
      upd(p1Id, p1Name, stats['1'] ?? 0, stats['2'] ?? 0, stats['3'] ?? 0, stats['7'] ?? 0);
      upd(p2Id, p2Name, stats['2'] ?? 0, stats['1'] ?? 0, stats['4'] ?? 0, stats['8'] ?? 0);
    }

    for (const f of upcoming) {
      if (prematchFired.has(f.fixtureId)) continue;
      const aiPrematch = allMarkets.filter(
        (m) => m.fixtureId === f.fixtureId && m.origin === 'ai' && m.lockRule === 'kickoff',
      );
      if (aiPrematch.length >= 1) {
        prematchFired.add(f.fixtureId); // authored on a previous run
        continue;
      }
      prematchFired.add(f.fixtureId); // at most one model call per fixture per process

      const teamP1 = f.homeIsP1 ? f.home : f.away;
      const teamP2 = f.homeIsP1 ? f.away : f.home;
      const p1Id = f.homeIsP1 ? f.homeId : f.awayId;
      const p2Id = f.homeIsP1 ? f.awayId : f.homeId;
      const ctxJson = {
        fixtureId: f.fixtureId,
        teamP1,
        teamP2,
        kickoff: new Date(f.startTime).toISOString(),
        knockoutForm: { teamP1: form.get(p1Id) ?? null, teamP2: form.get(p2Id) ?? null },
        existingQuestions: allMarkets
          .filter((m) => m.fixtureId === f.fixtureId)
          .map((m) => m.question),
      };
      const prompt = `You author PRE-MATCH prediction markets for an upcoming FIFA World Cup 2026 knockout match. You are a PARSER of the real data below — ground every line in the teams' knockout form.
STRICT GRAMMAR (anything else is rejected):
- statAKey/statBKey are base keys: 1=teamP1 goals, 2=teamP2 goals, 3=teamP1 yellow cards, 4=teamP2 yellows, 5=teamP1 reds, 6=teamP2 reds, 7=teamP1 corners, 8=teamP2 corners.
- period: 0=full game, 1=first half, 2=second half (all open pre-match).
- predicate: value(statA [op statB]) comparison threshold. op is "Add"|"Subtract"|null. comparison "GreaterThan"|"LessThan"|"EqualTo". Integer threshold. Over X.5 = GreaterThan floor(X.5).
- When op is set, both keys MUST be the same stat family.
BALANCE RULE: pick lines a bookmaker would set — near the expected value given the form data, genuinely uncertain both ways. One-sided lines are rejected.
Output ONLY JSON: {"markets":[{"slug","question","yesLabel","noLabel","fixtureId","period","statAKey","statBKey","comparison","threshold","op","rationale"}]}
MATCH DATA: ${JSON.stringify(ctxJson)}
fixtureId MUST be ${f.fixtureId}. Use exact team names in questions; cite the form numbers in rationale. Do NOT duplicate existingQuestions (the standard O/U goals, win, corners 8.5/10.5, yellows 3.5 markets already exist). Max 3 markets.`;

      const text = await geminiGenerate(prompt);
      if (!text) continue;
      let proposals: z.infer<typeof liveProposalSchema>['markets'];
      try {
        let raw: unknown = JSON.parse(text);
        if (Array.isArray(raw)) raw = { markets: raw };
        const parsed = liveProposalSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(' | ');
          console.error(`[ai-markets] prematch proposals rejected: ${issues}\n  raw: ${text.slice(0, 400)}`);
          continue;
        }
        proposals = parsed.data.markets;
      } catch {
        console.error(`[ai-markets] prematch proposals: non-JSON output discarded: ${text.slice(0, 300)}`);
        continue;
      }

      let created = 0;
      for (const p of proposals) {
        if (p.fixtureId !== f.fixtureId) continue;
        if (p.slug.length < 3) continue;
        if (created >= 3) break;
        const famA = STAT_FAMILY[p.statAKey]!;
        if (p.op !== null) {
          if (p.statBKey === null) continue;
          if (STAT_FAMILY[p.statBKey] !== famA) continue;
          if (p.statAKey === p.statBKey) continue;
        } else if (p.statBKey !== null) {
          continue;
        }
        if (p.threshold > FAMILY_MAX_THRESHOLD[famA]!) continue;
        const q = p.question.toLowerCase();
        const familyWord = { goals: 'goal', yellows: 'card', reds: 'card', corners: 'corner' }[famA];
        if (!q.includes(teamP1.toLowerCase()) && !q.includes(teamP2.toLowerCase()) && !q.includes(familyWord)) continue;
        if (/\btotal\b|\bcombined\b|\bboth teams\b/.test(q) && p.op !== 'Add') continue;
        const rejection = inPlayGuard(p, {}, SOCCER_STATUS.NS, 0);
        if (rejection) {
          console.log(`[ai-markets] prematch guard rejected ${p.slug}: ${rejection}`);
          continue;
        }

        const terms: PlainTerms = {
          fixtureId: p.fixtureId,
          period: 0, // proof leaf convention: half lives in the offset key
          statAKey: p.period * 1000 + p.statAKey,
          statBKey: p.statBKey === null ? null : p.period * 1000 + p.statBKey,
          predicate: { threshold: p.threshold, comparison: p.comparison },
          op: p.op,
          negation: false,
        };
        const hashHex = termsHashHex(fromPlainTerms(terms));
        if (existingHashes.has(hashHex)) continue;

        const lockTs = f.startTime - 2 * 60_000;
        let marketPda: string | null = null;
        let vaultPda: string | null = null;
        let createTx: string | null = null;
        try {
          const res = await createMarket(pool, ctx.keeper, terms, {
            lockTs: Math.floor(lockTs / 1000),
            resolveDeadlineTs: Math.floor((f.startTime + config.resolveDeadlineMs) / 1000),
          });
          marketPda = res.market.toBase58();
          vaultPda = res.vault.toBase58();
          createTx = res.signature;
          await new Promise((r) => setTimeout(r, config.createThrottleMs));
        } catch (err) {
          console.error(`[ai-markets] prematch pool create failed (${p.slug}): ${String(err).slice(0, 150)}`);
          continue;
        }

        await db
          .insert(schema.markets)
          .values({
            id: `${p.fixtureId}:ai-${p.slug}`,
            fixtureId: p.fixtureId,
            slug: `ai-${p.slug}`,
            marketClass: 'A',
            question: p.question,
            yesLabel: p.yesLabel,
            noLabel: p.noLabel,
            termsJson: JSON.stringify(terms),
            termsHash: hashHex,
            lockRule: 'kickoff',
            resolutionMethod:
              'Settled on-chain: Merkle proof of the match stat verified against the TxLINE daily scores root (AI special, grounded in knockout form)',
            state: 'Open',
            lockTs,
            resolveDeadlineTs: f.startTime + config.resolveDeadlineMs,
            marketPda,
            vaultPda,
            createTx,
            origin: 'ai',
            rationale: p.rationale,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        existingHashes.add(hashHex);
        created += 1;
        console.log(`[ai-markets] prematch special authored ${p.fixtureId}:ai-${p.slug} — ${p.question}`);
      }
    }
  }

  /** Returns false when there was nothing to work on yet (fresh DB before the
   * first fixtures sync) so the loop retries soon instead of sleeping 6h. */
  async function tick(): Promise<boolean> {
    await refreshStaleFixtures();
    const teams = await aliveTeams();
    if (!teams.length) return false;
    await updateScorers(); // still feeds the (clearly-disclaimed) scorer table

    // Retire the tournament award markets shipped before the coverage-window
    // realization (they never had pools, so deletion strands nothing).
    const allMarkets = await db.query.markets.findMany();
    for (const m of allMarkets) {
      if (m.id.startsWith('wc:') && m.marketClass === 'B') {
        await db.delete(schema.markets).where(eq(schema.markets.id, m.id));
        console.log(`[ai-markets] removed unsound award market ${m.id}`);
      }
    }

    const existing = allMarkets.filter(
      (m) => m.origin === 'ai' && !(m.id.startsWith('wc:') && m.marketClass === 'B'),
    );
    const existingSlugs = existing.map((m) => m.slug);
    // Dedupe on the RULE, not the slug — the same market under a different
    // wording is still the same market and must not ship twice.
    const existingRules = new Set(
      existing.map((m) => {
        try {
          const r = (JSON.parse(m.termsJson) as { tournamentRule?: TournamentRule }).tournamentRule;
          return r ? JSON.stringify(r) : `attached:${m.id}`;
        } catch {
          return `attached:${m.id}`;
        }
      }),
    );
    const teamIds = new Set(teams.map((t) => t.teamId));

    const proposals = [
      ...deterministicProposals(teams),
      ...(await aiProposals(teams, existingSlugs)),
    ];

    const now = Date.now();
    for (const p of proposals) {
      if (existingSlugs.includes(p.slug)) continue;
      if (existingRules.has(JSON.stringify(p.rule))) continue;
      // Hard validation against reality — an LLM cannot ship what isn't real.
      // Only champion markets are sound at tournament level: the coverage
      // window cannot see the whole tournament, so award aggregates are out.
      if (p.rule.kind !== 'champion' || p.tier !== 'chain') continue;
      if (!teamIds.has(p.rule.teamId)) continue;
      // Question text must actually name the real entity it settles on.
      const rule = p.rule;
      const teamName = teams.find((t) => t.teamId === rule.teamId)?.name ?? null;
      if (teamName && !p.question.toLowerCase().includes(teamName.toLowerCase())) continue;

      await db
        .insert(schema.markets)
        .values({
          id: `wc:${p.slug}`,
          fixtureId: 0, // tournament-level; attaches to the deciding fixture later
          slug: p.slug,
          marketClass: 'C',
          question: p.question,
          yesLabel: p.yesLabel,
          noLabel: p.noLabel,
          termsJson: JSON.stringify({ tournamentRule: p.rule }),
          termsHash: `tournament:${p.slug}`,
          lockRule: 'kickoff',
          resolutionMethod:
            'Attaches to the deciding fixture (final) and settles by its on-chain Merkle proof',
          state: 'Open',
          lockTs: now + 60 * 86_400_000, // re-set when the deciding fixture attaches
          resolveDeadlineTs: now + 90 * 86_400_000,
          origin: 'ai',
          rationale: p.rationale,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      existingSlugs.push(p.slug);
      console.log(`[ai-markets] authored ${p.slug} (${p.tier}): ${p.question}`);
    }

    // A champion market for a team knocked out of the bracket settles NO the
    // moment elimination is a fact — no reason to hold it until the final.
    const aliveIds = new Set(teams.map((t) => t.teamId));
    for (const m of existing.filter(
      (m) => m.marketClass === 'C' && m.fixtureId === 0 && m.state === 'Open',
    )) {
      try {
        const r = (JSON.parse(m.termsJson) as { tournamentRule?: TournamentRule }).tournamentRule;
        if (r?.kind === 'champion' && !aliveIds.has(r.teamId)) {
          await db
            .update(schema.markets)
            .set({ state: 'Settled', winnerYes: false, updatedAt: now })
            .where(eq(schema.markets.id, m.id));
          console.log(`[ai-markets] ${m.slug} settled NO — team eliminated`);
        }
      } catch {
        /* ignore malformed terms */
      }
    }

    // Attach champion markets to the final as soon as it is identifiable:
    // either one fixture remains, or exactly two teams are still alive and a
    // scheduled fixture pairs them (robust to a third-place match existing).
    const fixtures = await db.query.fixtures.findMany();
    const remaining = fixtures.filter((f) => f.competitionId === 72 && !fixtureDone(f));
    let finalFixture = remaining.length === 1 ? remaining[0]! : null;
    if (!finalFixture && teams.length === 2) {
      const aliveSet = new Set(teams.map((t) => t.teamId));
      finalFixture =
        remaining.find((f) => aliveSet.has(f.homeId) && aliveSet.has(f.awayId)) ?? null;
    }
    if (finalFixture) {
      const final = finalFixture;
      const detached = (await db.query.markets.findMany()).filter(
        (m) => m.origin === 'ai' && m.fixtureId === 0 && m.marketClass === 'C' && m.state === 'Open',
      );
      for (const m of detached) {
        const rule = (JSON.parse(m.termsJson) as { tournamentRule: TournamentRule }).tournamentRule;
        if (rule.kind !== 'champion') continue;
        const isHome = final.homeId === rule.teamId;
        const isAway = final.awayId === rule.teamId;
        if (!isHome && !isAway) {
          // Team eliminated before the final — market resolves NO at attach.
          await db
            .update(schema.markets)
            .set({ state: 'Settled', winnerYes: false, updatedAt: now })
            .where(eq(schema.markets.id, m.id));
          continue;
        }
        // Champion = this team wins the final: (their goals − other goals) > 0.
        const teamIsP1 = final.homeIsP1 ? isHome : isAway;
        const terms: PlainTerms = {
          fixtureId: final.fixtureId,
          period: 0,
          statAKey: teamIsP1 ? 1 : 2,
          statBKey: teamIsP1 ? 2 : 1,
          predicate: { threshold: 0, comparison: 'GreaterThan' },
          op: 'Subtract',
          negation: false,
        };
        // Real on-chain pool so the market becomes stakeable + proof-settled.
        let marketPda: string | null = null;
        let vaultPda: string | null = null;
        let createTx: string | null = null;
        try {
          const res = await createMarket(pool, ctx.keeper, terms, {
            lockTs: Math.floor((final.startTime - 2 * 60_000) / 1000),
            resolveDeadlineTs: Math.floor((final.startTime + config.resolveDeadlineMs) / 1000),
          });
          marketPda = res.market.toBase58();
          vaultPda = res.vault.toBase58();
          createTx = res.signature;
        } catch (err) {
          if (!/already in use/.test(String(err))) {
            console.error(`[ai-markets] pool create failed for ${m.slug}: ${String(err).slice(0, 150)}`);
            continue;
          }
        }
        await db
          .update(schema.markets)
          .set({
            fixtureId: final.fixtureId,
            termsJson: JSON.stringify(terms),
            marketPda,
            vaultPda,
            createTx,
            lockTs: final.startTime - 2 * 60_000,
            resolveDeadlineTs: final.startTime + config.resolveDeadlineMs,
            updatedAt: now,
          })
          .where(eq(schema.markets.id, m.id));
        console.log(`[ai-markets] attached ${m.slug} to final fixture ${final.fixtureId} (pool ${marketPda})`);
      }
    }

    return true;
  }

  const loop = async () => {
    let lastTournamentTick = 0;
    while (!stopped) {
      // Tournament author: slow cadence (rate-limit budget). A tick with no
      // fixtures yet (fresh DB before the first sync) retries every minute
      // instead of sleeping 6h; a crashed tick retries in 5 minutes.
      if (Date.now() - lastTournamentTick >= config.aiTickMs) {
        try {
          const didWork = await tick();
          if (didWork) lastTournamentTick = Date.now();
        } catch (err) {
          console.error('[ai-markets] tick failed', String(err).slice(0, 300));
          lastTournamentTick = Date.now() - config.aiTickMs + 5 * 60_000;
        }
      }
      // In-play author: checks every minute, but only CALLS the model when a
      // live match hits an unfired phase (kickoff / HT / ~60') — the AI acts
      // on the live feed, never on a timer.
      try {
        await liveAiTick();
      } catch (err) {
        console.error('[ai-markets] live tick failed', String(err).slice(0, 300));
      }
      // Pre-match specials: cheap DB check per minute; at most one model call
      // per upcoming fixture.
      try {
        await prematchAiTick();
      } catch (err) {
        console.error('[ai-markets] prematch tick failed', String(err).slice(0, 300));
      }
      await new Promise((r) => setTimeout(r, config.liveAiPollMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
