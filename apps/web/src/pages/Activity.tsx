import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { api } from '../lib/api.js';

/** Real notification feed from the backend (locks, settlements, receipts). */
export default function Activity() {
  const { publicKey } = useWallet();
  const { data: rows = [] } = useQuery({
    queryKey: ['notifications', publicKey?.toBase58()],
    queryFn: () => api.notifications(publicKey?.toBase58()),
    refetchInterval: 20_000,
  });

  if (!rows.length)
    return (
      <div className="panel">
        <div className="empty">
          No activity yet — market locks, settlements and receipts will appear here.
        </div>
      </div>
    );

  const label: Record<string, string> = {
    market_locked: '🔒 Market locked',
    market_resolved: '🧾 Market resolved',
    receipt_ready: '📜 Receipt ready',
    claim_ready: '💰 Claim ready',
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Activity</h2>
      </div>
      {rows.map((n) => {
        const payload = JSON.parse(n.payloadJson) as { marketId?: string; winnerYes?: boolean };
        return (
          <div className="activity-row" key={n.id}>
            <span>{label[n.kind] ?? n.kind}</span>
            <span style={{ fontWeight: 600 }}>{payload.marketId}</span>
            {payload.winnerYes !== undefined && (
              <span style={{ color: payload.winnerYes ? 'var(--yes)' : 'var(--no)', fontWeight: 700 }}>
                {payload.winnerYes ? 'YES' : 'NO'} won
              </span>
            )}
            <span className="when">{new Date(n.createdAt).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
