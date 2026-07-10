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
const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('champion'), teamId: z.number().int() }),
  z.object({ kind: z.literal('top-scorer'), playerId: z.number().int() }),
  // Award categories computable purely from aggregated TxLINE stats
  // (user decision 2026-07-10: TxLINE data only, the AI just parses it).
  z.object({ kind: z.literal('fair-play'), teamId: z.number().int() }),
  z.object({ kind: z.literal('clean-sheets'), teamId: z.number().int() }),
  z.object({ kind: z.literal('team-goals'), teamId: z.number().int() }),
]);

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

export function startAiMarketAuthor(ctx: Ctx, pool: Program<GroundtruthPool>) {
  let stopped = false;

  /** Winners of finished fixtures + participants of unfinished ones. */
  async function aliveTeams(): Promise<AliveTeam[]> {
    const fixtures = await db.query.fixtures.findMany();
    const wc = fixtures.filter((f) => f.competitionId === 72);
    const alive = new Map<number, string>();
    for (const f of wc) {
      const finished = f.statusId !== null && FINISHED_STATUSES.has(f.statusId);
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
    const finished = fixtures.filter(
      (f) => f.competitionId === 72 && f.statusId !== null && FINISHED_STATUSES.has(f.statusId),
    );
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

  interface TeamAggregate {
    teamId: number;
    name: string;
    matches: number;
    goals: number;
    yellows: number;
    reds: number;
    cleanSheets: number;
    /** FIFA fair-play style points from provable card stats: yellow −1, red −3
     * (the feed doesn't split direct/second-yellow reds; formula documented). */
    fairPlayPoints: number;
  }

  /** Per-team tournament aggregates from finished fixtures' final stat maps —
   * pure TxLINE data, the ground truth for every award category. */
  async function teamAggregates(): Promise<TeamAggregate[]> {
    const fixtures = await db.query.fixtures.findMany();
    const finished = fixtures.filter(
      (f) =>
        f.competitionId === 72 &&
        f.statusId !== null &&
        FINISHED_STATUSES.has(f.statusId) &&
        f.statsJson,
    );
    const byTeam = new Map<number, TeamAggregate>();
    const get = (teamId: number, name: string) => {
      let t = byTeam.get(teamId);
      if (!t) {
        t = { teamId, name, matches: 0, goals: 0, yellows: 0, reds: 0, cleanSheets: 0, fairPlayPoints: 0 };
        byTeam.set(teamId, t);
      }
      return t;
    };
    for (const f of finished) {
      const stats = JSON.parse(f.statsJson!) as Record<string, number>;
      const p1 = get(f.homeIsP1 ? f.homeId : f.awayId, f.homeIsP1 ? f.home : f.away);
      const p2 = get(f.homeIsP1 ? f.awayId : f.homeId, f.homeIsP1 ? f.away : f.home);
      const g1 = stats['1'] ?? 0;
      const g2 = stats['2'] ?? 0;
      p1.matches += 1;
      p2.matches += 1;
      p1.goals += g1;
      p2.goals += g2;
      p1.yellows += stats['3'] ?? 0;
      p2.yellows += stats['4'] ?? 0;
      p1.reds += stats['5'] ?? 0;
      p2.reds += stats['6'] ?? 0;
      if (g2 === 0) p1.cleanSheets += 1;
      if (g1 === 0) p2.cleanSheets += 1;
    }
    for (const t of byTeam.values()) t.fairPlayPoints = -(t.yellows + 3 * t.reds);
    return [...byTeam.values()];
  }

  function deterministicProposals(
    teams: AliveTeam[],
    topScorers: (typeof schema.scorers.$inferSelect)[],
    aggregates: TeamAggregate[] = [],
  ): z.infer<typeof proposalSchema>['markets'] {
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
    for (const s of topScorers.slice(0, 5)) {
      const label = s.name ?? `Player #${s.playerId}`;
      out.push({
        slug: `golden-boot-${s.playerId}`,
        question: `${label} (${s.team}) to win the Golden Boot?`,
        yesLabel: label,
        noLabel: 'Anyone else',
        tier: 'feed',
        rule: { kind: 'top-scorer', playerId: s.playerId },
        rationale: `Currently on ${s.goals} goals in our coverage window; resolved from aggregated feed PlayerStats.`,
      });
    }
    // Award categories, each grounded in the live tournament aggregates.
    const byFairPlay = [...aggregates].sort((a, b) => b.fairPlayPoints - a.fairPlayPoints);
    for (const t of byFairPlay.slice(0, 3)) {
      out.push({
        slug: `fair-play-${t.teamId}`,
        question: `${t.name} to win the Fair Play Award?`,
        yesLabel: t.name,
        noLabel: 'Any other team',
        tier: 'feed',
        rule: { kind: 'fair-play', teamId: t.teamId },
        rationale: `Best card record so far (${t.yellows} yellows, ${t.reds} reds in ${t.matches} matches); fair-play points from aggregated TxLINE card stats.`,
      });
    }
    const byCleanSheets = [...aggregates].sort((a, b) => b.cleanSheets - a.cleanSheets);
    for (const t of byCleanSheets.slice(0, 3)) {
      if (!t.cleanSheets) continue;
      out.push({
        slug: `clean-sheets-${t.teamId}`,
        question: `${t.name} to keep the most clean sheets?`,
        yesLabel: t.name,
        noLabel: 'Any other team',
        tier: 'feed',
        rule: { kind: 'clean-sheets', teamId: t.teamId },
        rationale: `${t.cleanSheets} clean sheet(s) in ${t.matches} matches so far, from aggregated TxLINE goal stats.`,
      });
    }
    const byGoals = [...aggregates].sort((a, b) => b.goals - a.goals);
    for (const t of byGoals.slice(0, 3)) {
      if (!t.goals) continue;
      out.push({
        slug: `team-goals-${t.teamId}`,
        question: `${t.name} to score the most goals in the tournament?`,
        yesLabel: t.name,
        noLabel: 'Any other team',
        tier: 'feed',
        rule: { kind: 'team-goals', teamId: t.teamId },
        rationale: `${t.goals} goals in ${t.matches} matches so far, from aggregated TxLINE goal stats.`,
      });
    }
    return out;
  }

  async function aiProposals(
    teams: AliveTeam[],
    topScorers: (typeof schema.scorers.$inferSelect)[],
    existingSlugs: string[],
    aggregates: TeamAggregate[],
  ): Promise<z.infer<typeof proposalSchema>['markets']> {
    const prompt = `You author prediction markets for the remaining FIFA World Cup 2026 tournament. You are a PARSER of the real TxLINE tournament data below — every market must follow from it.
STRICT RULES:
- Output ONLY JSON matching: {"markets":[{"slug","question","yesLabel","noLabel","tier","rule","rationale"}]}
- tier "chain" = resolvable purely from the final's match result. ONLY rule kind: {"kind":"champion","teamId":N} with a team still alive.
- tier "feed" = settled from aggregated stats. Allowed rule kinds:
    {"kind":"top-scorer","playerId":N}   — Golden Boot (most goals)
    {"kind":"fair-play","teamId":N}      — Fair Play Award (best card record: yellow −1, red −3)
    {"kind":"clean-sheets","teamId":N}   — most clean sheets
    {"kind":"team-goals","teamId":N}     — most goals scored as a team
- champion teamId MUST be from this list of teams still alive: ${JSON.stringify(teams)}
- playerId MUST be from these real current scorers: ${JSON.stringify(topScorers.map((s) => ({ playerId: s.playerId, name: s.name, team: s.team, goals: s.goals })))}
- fair-play/clean-sheets/team-goals teamId MUST come from these real tournament aggregates (pick plausible leaders, not no-hopers): ${JSON.stringify(aggregates)}
- NEVER invent teams, players, or award markets that require FIFA votes (no Golden Ball — nothing in the data can decide it).
- Skip slugs already used: ${JSON.stringify(existingSlugs)}
- Max 8 markets. Questions punchy, ≤100 chars, and MUST name the team/player.`;
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

  /** Returns a rejection reason, or null when the line is fair and undecided. */
  function inPlayGuard(
    p: { period: 0 | 1 | 2; statAKey: number; statBKey: number | null; comparison: string; threshold: number; op: string | null },
    stats: Record<string, number>,
    statusId: number,
    clockSeconds: number,
  ): string | null {
    if (p.period === 1) return 'first half already known in-play';
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
      p.period === 2 && statusId <= SOCCER_STATUS.HT
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

  /** Returns false when there was nothing to work on yet (fresh DB before the
   * first fixtures sync) so the loop retries soon instead of sleeping 6h. */
  async function tick(): Promise<boolean> {
    const teams = await aliveTeams();
    if (!teams.length) return false;
    await updateScorers();
    const topScorers = (await db.query.scorers.findMany()).sort((a, b) => b.goals - a.goals);

    const existing = (await db.query.markets.findMany()).filter((m) => m.origin === 'ai');
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
    const playerIds = new Set(topScorers.map((s) => s.playerId));
    const aggregates = await teamAggregates();
    const aggregateTeamIds = new Set(aggregates.map((t) => t.teamId));

    const proposals = [
      ...deterministicProposals(teams, topScorers, aggregates),
      ...(await aiProposals(teams, topScorers, existingSlugs, aggregates)),
    ];

    const now = Date.now();
    for (const p of proposals) {
      if (existingSlugs.includes(p.slug)) continue;
      if (existingRules.has(JSON.stringify(p.rule))) continue;
      // Hard validation against reality — an LLM cannot ship what isn't real.
      // Champion needs a team still alive; award kinds need a team that has
      // real aggregate data in the tournament.
      if (p.rule.kind === 'champion' && !teamIds.has(p.rule.teamId)) continue;
      if ('teamId' in p.rule && p.rule.kind !== 'champion' && !aggregateTeamIds.has(p.rule.teamId))
        continue;
      if ('playerId' in p.rule && !playerIds.has(p.rule.playerId)) continue;
      if (p.tier === 'chain' && p.rule.kind !== 'champion') continue;
      if (p.tier === 'feed' && p.rule.kind === 'champion') continue;
      // Question text must actually name the real entity it settles on.
      const rule = p.rule;
      const teamName =
        'teamId' in rule
          ? (teams.find((t) => t.teamId === rule.teamId)?.name ??
            aggregates.find((t) => t.teamId === rule.teamId)?.name ?? null)
          : null;
      if (teamName && !p.question.toLowerCase().includes(teamName.toLowerCase())) continue;

      await db
        .insert(schema.markets)
        .values({
          id: `wc:${p.slug}`,
          fixtureId: 0, // tournament-level; attaches to the deciding fixture later
          slug: p.slug,
          marketClass: p.tier === 'chain' ? 'C' : 'B',
          question: p.question,
          yesLabel: p.yesLabel,
          noLabel: p.noLabel,
          termsJson: JSON.stringify({ tournamentRule: p.rule }),
          termsHash: `tournament:${p.slug}`,
          lockRule: 'kickoff',
          resolutionMethod:
            p.tier === 'chain'
              ? 'Attaches to the deciding fixture (final) and settles by its on-chain Merkle proof'
              : {
                  'top-scorer':
                    'Golden Boot — most tournament goals, from aggregated TxLINE PlayerStats — NOT chain-proven',
                  'fair-play':
                    'Fair Play Award — best card record (yellow −1, red −3) from aggregated TxLINE card stats — NOT chain-proven',
                  'clean-sheets':
                    'Most clean sheets, counted from aggregated TxLINE goal stats — NOT chain-proven',
                  'team-goals':
                    'Most team goals, summed from aggregated TxLINE goal stats — NOT chain-proven',
                  champion: 'Feed-attested — NOT chain-proven',
                }[p.rule.kind],
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

    // Player names can arrive after a market was authored — refresh labels.
    for (const m of existing.filter((m) => m.marketClass === 'B' && m.question.includes('Player #'))) {
      const rule = (JSON.parse(m.termsJson) as { tournamentRule?: TournamentRule }).tournamentRule;
      if (rule?.kind !== 'top-scorer') continue;
      const s = topScorers.find((x) => x.playerId === rule.playerId);
      if (!s?.name) continue;
      await db
        .update(schema.markets)
        .set({
          question: `${s.name} (${s.team}) to win the Golden Boot?`,
          yesLabel: s.name,
          updatedAt: now,
        })
        .where(eq(schema.markets.id, m.id));
      console.log(`[ai-markets] refreshed label ${m.slug} → ${s.name}`);
    }

    // Attach champion markets to the final once exactly one WC fixture remains.
    const fixtures = await db.query.fixtures.findMany();
    const remaining = fixtures.filter(
      (f) =>
        f.competitionId === 72 && !(f.statusId !== null && FINISHED_STATUSES.has(f.statusId)),
    );
    if (remaining.length === 1) {
      const final = remaining[0]!;
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

    // Tournament over: settle every feed-tier award market from the final
    // TxLINE aggregates. Ties settle YES for every tied leader — the only
    // reading the data itself can prove (we can't apply FIFA's unprovable
    // tiebreakers like assists or jury decisions).
    if (remaining.length === 0 && aggregates.length) {
      const feedMarkets = (await db.query.markets.findMany()).filter(
        (m) =>
          m.origin === 'ai' &&
          m.marketClass === 'B' &&
          !['Settled', 'Void'].includes(m.state),
      );
      const maxPlayerGoals = Math.max(0, ...topScorers.map((s) => s.goals));
      const maxFairPlay = Math.max(...aggregates.map((t) => t.fairPlayPoints));
      const maxCleanSheets = Math.max(0, ...aggregates.map((t) => t.cleanSheets));
      const maxTeamGoals = Math.max(0, ...aggregates.map((t) => t.goals));
      for (const m of feedMarkets) {
        let rule: TournamentRule | undefined;
        try {
          rule = (JSON.parse(m.termsJson) as { tournamentRule?: TournamentRule }).tournamentRule;
        } catch {
          continue;
        }
        if (!rule) continue;
        let winnerYes: boolean | null = null;
        if (rule.kind === 'top-scorer') {
          const s = topScorers.find((x) => x.playerId === rule.playerId);
          winnerYes = !!s && maxPlayerGoals > 0 && s.goals === maxPlayerGoals;
        } else if (rule.kind === 'fair-play') {
          const t = aggregates.find((x) => x.teamId === rule.teamId);
          winnerYes = !!t && t.fairPlayPoints === maxFairPlay;
        } else if (rule.kind === 'clean-sheets') {
          const t = aggregates.find((x) => x.teamId === rule.teamId);
          winnerYes = !!t && maxCleanSheets > 0 && t.cleanSheets === maxCleanSheets;
        } else if (rule.kind === 'team-goals') {
          const t = aggregates.find((x) => x.teamId === rule.teamId);
          winnerYes = !!t && maxTeamGoals > 0 && t.goals === maxTeamGoals;
        }
        if (winnerYes === null) continue;
        await db
          .update(schema.markets)
          .set({ state: 'Settled', winnerYes, evidenceTs: now, updatedAt: now })
          .where(eq(schema.markets.id, m.id));
        console.log(`[ai-markets] award settled ${m.slug} → ${winnerYes ? 'YES' : 'NO'}`);
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
      await new Promise((r) => setTimeout(r, config.liveAiPollMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
