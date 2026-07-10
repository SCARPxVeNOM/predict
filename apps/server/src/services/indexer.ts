import { and, eq, inArray } from 'drizzle-orm';
import type { Scores } from '@groundtruth/txline-client';
import { FINISHED_STATUSES, VOID_STATUSES, decidingStatusFor, SOCCER_STATUS } from '@groundtruth/catalog';
import { db, schema } from '../db/index.js';
import type { Ctx } from './txline.js';
import { bus } from './bus.js';

/**
 * Live indexer (spec §10.2): one durable SSE consumer of the scores stream.
 * Maintains fixture state, drives market state transitions, captures Class-B
 * evidence, and fans updates out to connected frontends via the event bus.
 */
export function startIndexer(ctx: Ctx) {
  let stopped = false;
  let es: { close(): void } | null = null;

  async function apply(record: Scores) {
    const now = Date.now();
    const fixtureId = record.FixtureId;

    const fixture = await db.query.fixtures.findFirst({
      where: eq(schema.fixtures.fixtureId, fixtureId),
    });
    if (!fixture) return; // not a covered fixture

    // Some action records carry undocumented StatusId values (e.g. 100) or a
    // zeroed clock — only trust values in the documented 1–19 phase range and
    // non-zero clocks, otherwise keep the previous state.
    const rawStatus = record.StatusId;
    let statusId =
      rawStatus !== undefined && rawStatus >= 1 && rawStatus <= 19
        ? rawStatus
        : (fixture.statusId ?? undefined);
    // Finished is terminal: replayed/late records must never regress a
    // final status back to a live one (this once resurrected an eliminated
    // team in the bracket). Void statuses may still override.
    if (
      fixture.statusId !== null &&
      FINISHED_STATUSES.has(fixture.statusId) &&
      statusId !== undefined &&
      !FINISHED_STATUSES.has(statusId) &&
      !VOID_STATUSES.has(statusId)
    ) {
      statusId = fixture.statusId;
    }
    const clockSeconds =
      record.Clock && record.Clock.Seconds > 0 ? record.Clock.Seconds : fixture.clockSeconds;
    await db
      .update(schema.fixtures)
      .set({
        statusId: statusId ?? null,
        clockSeconds,
        scoreJson: record.Score ? JSON.stringify(record.Score) : fixture.scoreJson,
        statsJson:
          record.Stats && Object.keys(record.Stats).length
            ? JSON.stringify(record.Stats)
            : fixture.statsJson,
        lastSeq: record.Seq,
        lastTs: record.Ts,
        updatedAt: now,
      })
      .where(eq(schema.fixtures.fixtureId, fixtureId));

    // ---- market state transitions -------------------------------------
    const open = await db.query.markets.findMany({
      where: and(
        eq(schema.markets.fixtureId, fixtureId),
        inArray(schema.markets.state, ['Open', 'Locked', 'InPlay', 'AwaitingRoot']),
      ),
    });

    for (const m of open) {
      let next = m.state;

      if (statusId !== undefined && VOID_STATUSES.has(statusId)) {
        next = 'Void'; // settler performs the on-chain void after the deadline
      } else if (
        m.state === 'Open' &&
        (now >= m.lockTs ||
          // In-play markets are created mid-match by design and lock purely by
          // their own timed window, never by "the match has started".
          (statusId !== undefined && statusId !== SOCCER_STATUS.NS && m.lockRule !== 'in-play'))
      ) {
        next = 'Locked';
      }
      if ((next === 'Locked' || m.state === 'Locked') && statusId !== undefined && statusId >= 2 && statusId <= 13) {
        next = 'InPlay';
      }
      if (
        (next === 'InPlay' || m.state === 'InPlay') &&
        statusId !== undefined &&
        decidingStatusFor(JSON.parse(m.termsJson).period as number).has(statusId)
      ) {
        // Deciding phase complete — wait for the 5-minute batch root.
        next = 'AwaitingRoot';
      }

      if (next !== m.state) {
        await db
          .update(schema.markets)
          .set({ state: next, updatedAt: now })
          .where(eq(schema.markets.id, m.id));
        bus.emit('market', { id: m.id, state: next });
        if (next === 'Locked') {
          await db.insert(schema.notifications).values({
            wallet: null,
            kind: 'market_locked',
            payloadJson: JSON.stringify({ marketId: m.id }),
            createdAt: now,
          });
        }
      }
    }

    // ---- Class-B evidence: goal actions carry the scorer PlayerId -------
    if (record.Action === 'goal' && record.Data?.PlayerId) {
      const classB = await db.query.markets.findMany({
        where: and(eq(schema.markets.fixtureId, fixtureId), eq(schema.markets.marketClass, 'B')),
      });
      for (const m of classB) {
        await db.insert(schema.evidenceSnapshots).values({
          marketId: m.id,
          fixtureId,
          seq: record.Seq,
          ts: record.Ts,
          playerId: record.Data.PlayerId,
          rawJson: JSON.stringify(record),
          createdAt: now,
        });
      }
    }

    bus.emit('score', {
      fixtureId,
      statusId,
      seq: record.Seq,
      ts: record.Ts,
      action: record.Action,
      score: record.Score ?? null,
    });
  }

  function connect() {
    if (stopped) return;
    console.log('[indexer] connecting scores stream');
    es = ctx.txline.scoresStream({
      onMessage: ({ record }) => void apply(record).catch((e) => console.error('[indexer]', e)),
      onOpen: () => console.log('[indexer] stream open'),
      onError: (err) => console.error('[indexer] stream error', String(err).slice(0, 200)),
    });
  }

  // Hydrate current state for live/imminent fixtures, then stream.
  void (async () => {
    try {
      const fxs = await db.query.fixtures.findMany();
      const soon = fxs.filter((f) => Math.abs(Date.now() - f.startTime) < 6 * 3600_000);
      for (const f of soon) {
        const snaps = await ctx.txline.scoresSnapshot(f.fixtureId).catch(() => []);
        for (const s of snaps.sort((a, b) => a.Seq - b.Seq)) await apply(s);
      }
    } catch (err) {
      console.error('[indexer] hydration failed', String(err).slice(0, 200));
    }
    connect();
  })();

  return () => {
    stopped = true;
    es?.close();
  };
}
