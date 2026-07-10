/** Inspect the real Lineups record shape (for scorer-name extraction). */
import { bootstrap } from './env.js';

const { client } = await bootstrap();
const snaps = await client.scoresSnapshot(Number(process.argv[2] ?? 18209181));
const lineups = snaps.filter((s) => s.Action === 'lineups' || s.Lineups);
console.log(`lineup-ish records: ${lineups.length}`);
const sample = lineups[lineups.length - 1];
if (sample) {
  console.log(JSON.stringify(sample.Lineups ?? sample, null, 1).slice(0, 1800));
}
