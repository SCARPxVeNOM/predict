import { useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api.js';
import { flagSrc } from '../lib/flags.js';
import MarketCard from '../components/MarketCard.js';

interface ScorerRow {
  playerId: number;
  name: string | null;
  team: string | null;
  goals: number;
}

/**
 * Tournament-level markets, authored by the AI market service and validated
 * against real bracket/scorer data. Chain-tier outrights (champion, finalist)
 * attach to a real on-chain pool the moment the deciding fixture exists;
 * Golden Boot markets are feed-attested and labeled as such.
 */
export default function Predictions() {
  const { data: markets = [] } = useQuery({ queryKey: ['markets'], queryFn: () => api.markets() });
  const { data: fixtures = [] } = useQuery({ queryKey: ['fixtures'], queryFn: () => api.fixtures() });
  const { data: scorers = [] } = useQuery<ScorerRow[]>({
    queryKey: ['scorers'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/tournament/scorers`);
      return (await res.json()) as ScorerRow[];
    },
    refetchInterval: 60_000,
  });

  const tournament = markets.filter((m) => m.id.startsWith('wc:'));
  // Live contenders first; eliminated (settled) teams sink to the end, dimmed.
  const outrights = tournament
    .filter((m) => m.marketClass === 'C')
    .sort((a, b) => Number(a.state === 'Settled') - Number(b.state === 'Settled'));
  const feed = tournament.filter((m) => m.marketClass === 'B');
  // Award categories are keyed by slug prefix (server-side rule kinds).
  const scorerMarkets = feed.filter((m) => m.slug.startsWith('golden-boot'));
  const awardSections: [string, string, typeof feed][] = [
    [
      'Fair Play Award',
      'Best card record — fair-play points (yellow −1, red −3) from aggregated TxLINE card stats.',
      feed.filter((m) => m.slug.startsWith('fair-play')),
    ],
    [
      'Most clean sheets',
      'Clean sheets counted from aggregated TxLINE goal stats across the tournament.',
      feed.filter((m) => m.slug.startsWith('clean-sheets')),
    ],
    [
      'Most team goals',
      'Team goals summed from aggregated TxLINE goal stats across the tournament.',
      feed.filter((m) => m.slug.startsWith('team-goals')),
    ],
  ];
  const knownPrefixes = ['golden-boot', 'fair-play', 'clean-sheets', 'team-goals'];
  const otherFeed = feed.filter((m) => !knownPrefixes.some((p) => m.slug.startsWith(p)));

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
          Champion &amp; bracket markets — authored automatically, settled by the deciding match's
          on-chain Merkle proof. Staking opens when the deciding fixture is announced.
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

      <div className="panel">
        <div className="panel-head">
          <h2>Golden Boot race</h2>
        </div>
        <div className="panel-sub">
          Real goals aggregated from the TxLINE per-match player stats (coverage window) —
          feed-attested, not chain-proven, and labeled that way.
        </div>
        {!scorers.length ? (
          <div className="empty">Scorer standings build up as covered matches finish.</div>
        ) : (
          <table className="lb">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Team</th>
                <th>Goals</th>
              </tr>
            </thead>
            <tbody>
              {scorers.map((s, i) => (
                <tr key={s.playerId}>
                  <td>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{s.name ?? `Player #${s.playerId}`}</td>
                  <td>
                    {s.team && flagSrc(s.team) && (
                      <img className="flag" src={flagSrc(s.team)!} alt="" style={{ marginRight: 6 }} />
                    )}
                    {s.team}
                  </td>
                  <td style={{ fontWeight: 700 }}>{s.goals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {scorerMarkets.length > 0 && (
          <>
            <h3 className="sec">Top-scorer markets</h3>
            <div className="cards">
              {scorerMarkets.map((m) => (
                <MarketCard key={m.id} m={m} />
              ))}
            </div>
          </>
        )}
      </div>

      {awardSections.map(
        ([title, sub, items]) =>
          items.length > 0 && (
            <div className="panel" key={title}>
              <div className="panel-head">
                <h2>{title}</h2>
              </div>
              <div className="panel-sub">{sub} Feed-attested, not chain-proven — and labeled that way.</div>
              <div className="cards">
                {items.map((m) => (
                  <MarketCard key={m.id} m={m} />
                ))}
              </div>
            </div>
          ),
      )}

      {otherFeed.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>More tournament markets</h2>
          </div>
          <div className="cards">
            {otherFeed.map((m) => (
              <MarketCard key={m.id} m={m} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
