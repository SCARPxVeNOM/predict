import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, subscribeStream, type FixtureRow, type MarketRow } from '../lib/api.js';
import { decimalOdds, isLive, minuteChip, scoreOf, usdt } from '../lib/format.js';
import MarketCard from '../components/MarketCard.js';
import Sparkline from '../components/Sparkline.js';
import { flagSrc } from '../lib/flags.js';

export default function Live({ search }: { search: string }) {
  const qc = useQueryClient();
  const { data: fixtures = [] } = useQuery({ queryKey: ['fixtures'], queryFn: api.fixtures });
  const { data: markets = [] } = useQuery({ queryKey: ['markets'], queryFn: () => api.markets() });

  useEffect(() => {
    const off = subscribeStream({
      onScore: () => void qc.invalidateQueries({ queryKey: ['fixtures'] }),
      onMarket: () => void qc.invalidateQueries({ queryKey: ['markets'] }),
    });
    return off;
  }, [qc]);

  const fixtureById = useMemo(() => new Map(fixtures.map((f) => [f.fixtureId, f])), [fixtures]);

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    // Auto-archive: cards from matches that kicked off >12h ago drop off the
    // Live page (settled positions/receipts stay on Portfolio forever).
    const cutoff = Date.now() - 12 * 3600_000;
    let rows = markets.filter((m) => {
      const f = fixtureById.get(m.fixtureId);
      return f !== undefined && f.startTime > cutoff;
    });
    if (q) {
      rows = rows.filter((m) => {
        const f = fixtureById.get(m.fixtureId)!;
        return (
          m.question.toLowerCase().includes(q) ||
          f.home.toLowerCase().includes(q) ||
          f.away.toLowerCase().includes(q)
        );
      });
    }
    return rows;
  }, [markets, fixtureById, q]);

  // Live now = markets whose fixture is in play; otherwise upcoming.
  const liveNow = visible.filter((m) => isLive(fixtureById.get(m.fixtureId)!));
  const hero = (liveNow.length ? liveNow : visible)
    .slice()
    .sort((a, b) => b.yesPool + b.noPool - (a.yesPool + a.noPool));
  const heroCards = hero.slice(0, 8);
  const maxVol = heroCards.reduce((mx, m) => Math.max(mx, m.yesPool + m.noPool), 0);

  const popular = visible
    .filter((m) => m.yesPool + m.noPool > 0)
    .sort((a, b) => b.yesPool + b.noPool - (a.yesPool + a.noPool))
    .slice(0, 8);

  const anyLive = fixtures.some(isLive);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Live Markets</h2>
          {anyLive && (
            <>
              <span className="live-dot" />
              <span className="live-label">Live now</span>
            </>
          )}
          <span className="spacer" />
        </div>
        <div className="panel-sub">Real-time markets powered by TxODDS data (devnet, ~60s delay)</div>
        {heroCards.length === 0 ? (
          <div className="empty">
            {q ? 'No markets match your search.' : 'No live markets yet — cards appear as fixtures approach kickoff.'}
          </div>
        ) : (
          <div className="cards">
            {heroCards.map((m) => (
              <MarketCard
                key={m.id}
                m={m}
                fixture={fixtureById.get(m.fixtureId)}
                hot={maxVol > 0 && m.yesPool + m.noPool === maxVol}
              />
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Popular Live Markets</h2>
          <span className="spacer" />
        </div>
        <div className="panel-sub">Highest real volume right now</div>
        {popular.length === 0 ? (
          <div className="empty">Volume appears as soon as wallets stake on-chain.</div>
        ) : (
          <PopularTable rows={popular} fixtureById={fixtureById} />
        )}
      </div>
    </>
  );
}

function PopularTable({
  rows,
  fixtureById,
}: {
  rows: MarketRow[];
  fixtureById: Map<number, FixtureRow>;
}) {
  return (
    <table className="popular">
      <thead>
        <tr>
          <th>Market</th>
          <th>Match</th>
          <th>{'Yes'}</th>
          <th>{'No'}</th>
          <th>Volume</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const f = fixtureById.get(m.fixtureId)!;
          const odds = decimalOdds(m);
          const min = minuteChip(f);
          return (
            <tr key={m.id}>
              <td style={{ fontWeight: 600 }}>{m.question}</td>
              <td className="match-cell">
                {flagSrc(f.home) && <img className="flag" src={flagSrc(f.home)!} alt="" />}{' '}
                {f.home} {scoreOf(f)} {f.away}{' '}
                {flagSrc(f.away) && <img className="flag" src={flagSrc(f.away)!} alt="" />}
                {min && <span className="min">{min}</span>}
              </td>
              <td>
                <span className="pill yes">{odds.yes}</span>
              </td>
              <td>
                <span className="pill no">{odds.no}</span>
              </td>
              <td>{usdt(m.yesPool + m.noPool)} USDT</td>
              <td style={{ width: 90 }}>
                <Sparkline marketId={m.id} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
