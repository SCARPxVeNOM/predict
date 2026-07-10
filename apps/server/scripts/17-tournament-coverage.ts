/** Does the devnet WC (competition 72) predate our coverage window? If the
 * bracket we see IS the whole tournament, full-tournament aggregates (Golden
 * Boot) are sound; if there are earlier fixtures we can't see, they are not. */
import { bootstrap } from './env.js';
import { epochDay } from '@groundtruth/shared';

const { client } = await bootstrap();
for (const daysBack of [60, 30, 14, 7]) {
  const fx = await client.fixturesSnapshot({ startEpochDay: epochDay() - daysBack });
  const wc = fx.filter((f) => f.CompetitionId === 72).sort((a, b) => a.StartTime - b.StartTime);
  console.log(`-- ${daysBack}d back: ${wc.length} WC fixtures`);
  for (const f of wc) {
    console.log(
      '  ',
      f.FixtureId,
      `${f.Participant1} vs ${f.Participant2}`,
      new Date(f.StartTime).toISOString(),
    );
  }
}
