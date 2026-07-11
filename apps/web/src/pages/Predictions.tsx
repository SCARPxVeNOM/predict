import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import MarketCard from '../components/MarketCard.js';

/**
 * Tournament-level markets. ONLY markets the data can truthfully settle live
 * here: knockout-tie winners (per-match on-chain proofs) and champion
 * outrights (settled by the final's proof once the pairing is known).
 *
 * Tournament AWARD markets (Golden Boot, Fair Play, …) were removed
 * 2026-07-11: those aggregate the WHOLE tournament, but the TxLINE coverage
 * window cannot see the group stage — no data source we have can settle them
 * honestly, so they must not exist.
 */
export default function Predictions() {
  const { data: markets = [] } = useQuery({ queryKey: ['markets'], queryFn: () => api.markets() });
  const { data: fixtures = [] } = useQuery({ queryKey: ['fixtures'], queryFn: () => api.fixtures() });

  const tournament = markets.filter((m) => m.id.startsWith('wc:'));
  // Live contenders first; eliminated (settled) teams sink to the end, dimmed.
  const outrights = tournament
    .filter((m) => m.marketClass === 'C')
    .sort((a, b) => Number(a.state === 'Settled') - Number(b.state === 'Settled'));

  // Stakeable NOW: each remaining knockout tie's winner pools (the same
  // on-chain markets as the Live page, framed as bracket progression).
  const FINISHED = [5, 10, 13, 14, 15, 16, 17, 18];
  const upcoming = fixtures
    .filter(
      (f) =>
        (f.statusId === null || !FINISHED.includes(f.statusId)) &&
        f.startTime > Date.now() - 3 * 3600_000,
    )
    .sort((a, b) => a.startTime - b.startTime);
  const roadToFinal = upcoming.flatMap((f) =>
    markets
      .filter(
        (m) => m.fixtureId === f.fixtureId && (m.slug === 'home-win' || m.slug === 'away-win'),
      )
      .map((m) => ({ m, f })),
  );

  // AI-authored specials for upcoming/live fixtures: extra provable markets
  // beyond the fixed catalog, grounded in the knockout form data we hold.
  const fixtureById = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const aiSpecials = markets
    .filter((m) => {
      if (m.origin !== 'ai' || m.fixtureId <= 0) return false;
      const f = fixtureById.get(m.fixtureId);
      return f !== undefined && f.startTime > Date.now() - 12 * 3600_000;
    })
    .sort((a, b) => {
      const fa = fixtureById.get(a.fixtureId)!.startTime;
      const fb = fixtureById.get(b.fixtureId)!.startTime;
      return fa - fb;
    });

  return (
    <>
      {roadToFinal.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Road to the Final</h2>
          </div>
          <div className="panel-sub">
            Back a team to win their knockout tie — stakeable right now, settled by the match's
            on-chain Merkle proof. Champion pools open once the final pairing is known.
          </div>
          <div className="cards">
            {roadToFinal.map(({ m, f }) => (
              <MarketCard key={m.id} m={m} fixture={f} />
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Tournament Outrights</h2>
        </div>
        <div className="panel-sub">
          Champion markets — authored automatically from the live bracket, settled by the final's
          on-chain Merkle proof. Only markets our data can truthfully settle exist here: awards
          like the Golden Boot need full-tournament stats the licensed feed's coverage window
          cannot provide, so we do not offer them.
        </div>
        {!outrights.length ? (
          <div className="empty">
            Outright markets are generated from the live bracket — they appear as soon as the
            remaining teams are known (the market author runs every few hours).
          </div>
        ) : (
          <div className="cards">
            {outrights.map((m) => (
              <div key={m.id} style={m.state === 'Settled' ? { opacity: 0.55 } : undefined}>
                <MarketCard m={m} />
                {!m.marketPda && m.state === 'Open' && (
                  <div className="mini-note" style={{ marginTop: 6 }}>
                    ⏳ champion stakes open when the final pairing is known — until then, back
                    them in Road to the Final above
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {aiSpecials.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>AI Specials</h2>
          </div>
          <div className="panel-sub">
            Extra markets authored by the AI from the TxLINE data it holds — knockout form
            pre-match, the live stat feed in-play. Every one is a real on-chain pool inside the
            provable stat grammar: locks at kickoff (or a short in-play window), settles by
            Merkle proof, voids and refunds automatically if it ever can't.
          </div>
          <div className="cards">
            {aiSpecials.map((m) => (
              <div key={m.id}>
                <MarketCard m={m} fixture={fixtureById.get(m.fixtureId)} />
                {m.rationale && (
                  <div className="mini-note" style={{ marginTop: 6 }}>
                    🤖 {m.rationale}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
