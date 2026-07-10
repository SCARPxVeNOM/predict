/** Smoke 3: list covered fixtures (today onward) with the activated token. */
import { epochDay } from '@groundtruth/shared';
import { bootstrap } from './env.js';

const { client } = await bootstrap();

const fixtures = await client.fixturesSnapshot({ startEpochDay: epochDay() });
console.log(`Fixtures covered (from today): ${fixtures.length}`);

const byCompetition = new Map<string, number>();
for (const f of fixtures) {
  byCompetition.set(
    `${f.CompetitionId} ${f.Competition}`,
    (byCompetition.get(`${f.CompetitionId} ${f.Competition}`) ?? 0) + 1,
  );
}
console.log('By competition:');
for (const [comp, count] of byCompetition) console.log(`  ${comp}: ${count}`);

for (const f of fixtures.slice(0, 15)) {
  const when = new Date(f.StartTime).toISOString();
  console.log(`  #${f.FixtureId} ${f.Participant1} vs ${f.Participant2} @ ${when}`);
}
