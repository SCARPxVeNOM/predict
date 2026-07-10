import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

export default function Leaderboard() {
  const { data: rows = [] } = useQuery({ queryKey: ['leaderboard'], queryFn: api.leaderboard });

  if (!rows.length)
    return (
      <div className="panel">
        <div className="empty">
          No settled positions yet — rankings appear after the first on-chain settlement.
        </div>
      </div>
    );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Leaderboard</h2>
      </div>
      <table className="lb">
      <thead>
        <tr>
          <th>#</th>
          <th>Wallet</th>
          <th>Realized P&L (USDT)</th>
          <th>W / L</th>
          <th title="Share of wins that are chain-verified (Class A) — only a proof-native market can show this">
            Verified accuracy
          </th>
          <th>Staked</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const acc = r.wins ? Math.round((r.verifiedWins / r.wins) * 100) : 0;
          return (
            <tr key={r.wallet}>
              <td>{i + 1}</td>
              <td className="mono">{r.wallet.slice(0, 4)}…{r.wallet.slice(-4)}</td>
              <td className={r.realizedPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {r.realizedPnl >= 0 ? '+' : ''}
                {r.realizedPnl.toFixed(2)}
              </td>
              <td>
                {r.wins} / {r.losses}
              </td>
              <td>{acc}% chain-verified</td>
              <td>{r.staked.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
      </table>
    </div>
  );
}
