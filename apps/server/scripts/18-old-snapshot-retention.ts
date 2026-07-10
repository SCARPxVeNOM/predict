/** Are score snapshots (Stats + PlayerStats) still retrievable for early
 * tournament fixtures? Decides whether full-tournament aggregates are sound. */
import { bootstrap } from './env.js';
import { epochDay } from '@groundtruth/shared';

const { client } = await bootstrap();
const fx = await client.fixturesSnapshot({ startEpochDay: epochDay() - 60 });
const wc = fx.filter((f) => f.CompetitionId === 72).sort((a, b) => a.StartTime - b.StartTime);

// Sample across the tournament: opening match, mid group stage, recent.
const samples = [wc[0]!, wc[Math.floor(wc.length / 3)]!, wc[Math.floor((2 * wc.length) / 3)]!];
for (const f of samples) {
  try {
    const snaps = await client.scoresSnapshot(f.FixtureId);
    const withStats = snaps.filter((s) => s.Stats && Object.keys(s.Stats).length > 0);
    const withPs = snaps.filter((s) => s.PlayerStats);
    const last = withStats.at(-1);
    console.log(
      `${f.FixtureId} ${f.Participant1} vs ${f.Participant2} (${new Date(f.StartTime).toISOString().slice(0, 10)}): ` +
        `records=${snaps.length} stats=${withStats.length} playerStats=${withPs.length} ` +
        `finalGoals=${last ? `${last.Stats!['1'] ?? 0}-${last.Stats!['2'] ?? 0}` : 'n/a'}`,
    );
  } catch (err) {
    console.log(`${f.FixtureId} ${f.Participant1} vs ${f.Participant2}: ERROR ${String(err).slice(0, 120)}`);
  }
}
