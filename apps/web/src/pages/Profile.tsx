import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { api } from '../lib/api.js';
import { usdt } from '../lib/format.js';
import { sendClaim } from '../lib/solana.js';
import ReceiptView from '../components/ReceiptView.js';

export default function Profile() {
  const wallet = useAnchorWallet();
  const address = wallet?.publicKey.toBase58();
  const [claiming, setClaiming] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: positions = [], refetch } = useQuery({
    queryKey: ['positions', address],
    queryFn: () => api.walletPositions(address!),
    enabled: !!address,
  });

  if (!address)
    return (
      <div className="panel">
        <div className="empty">Connect a wallet to see your portfolio and receipts.</div>
      </div>
    );

  const open = positions.filter((p) => p.market && !['Settled', 'Void'].includes(p.market.state));
  const settled = positions.filter((p) => p.market && ['Settled', 'Void'].includes(p.market.state));

  async function claim(marketPda: string, sideYes: boolean, marketId: string) {
    if (!wallet) return;
    setClaiming(marketId);
    setMsg(null);
    try {
      const sig = await sendClaim(wallet, marketPda, sideYes);
      setMsg(`Claimed ✓ ${sig.slice(0, 12)}…`);
      void refetch();
    } catch (err) {
      setMsg(String(err).slice(0, 160));
    } finally {
      setClaiming(null);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Portfolio</h2>
      </div>
      {msg && <div className="notice">{msg}</div>}
      <h3 className="sec">Open positions</h3>
      {!open.length && <div className="empty">No open positions.</div>}
      <div className="cards">
        {open.map((p) => (
          <div className="mcard" key={p.id}>
            <div className="mcard-q">{p.market!.question}</div>
            <div className="mcard-foot">
              <span>
                {p.sideYes ? p.market!.yesLabel : p.market!.noLabel} · {usdt(p.amount)} USDT
              </span>
              <span className={`state-chip ${p.market!.state}`}>{p.market!.state}</span>
            </div>
          </div>
        ))}
      </div>

      <h3 className="sec">Receipts wall</h3>
      {!settled.length && <div className="empty">Settled positions appear here with their proofs.</div>}
      <div className="cards">
        {settled.map((p) => {
          const m = p.market!;
          const won = m.state === 'Settled' && m.winnerYes !== null && p.sideYes === m.winnerYes;
          const voided = m.state === 'Void';
          const claimable = (won || voided) && !p.claimed && m.marketPda;
          return (
            <div className="mcard" key={p.id}>
              <div className="mcard-top">
                <span className={`class-chip ${m.marketClass}`}>
                  {m.marketClass === 'A' ? 'CHAIN-VERIFIED' : 'FEED-RESOLVED'}
                </span>
              </div>
              <div className="mcard-q">{m.question}</div>
              <div className="mcard-foot">
                <span>
                  {p.sideYes ? m.yesLabel : m.noLabel} · {usdt(p.amount)} USDT ·{' '}
                  <b style={{ color: voided ? 'var(--muted)' : won ? 'var(--green)' : 'var(--no)' }}>
                    {voided ? 'VOID' : won ? 'WON' : 'LOST'}
                  </b>
                  {p.claimed && ' · claimed'}
                </span>
                {claimable && (
                  <button
                    className="primary"
                    disabled={claiming === m.id}
                    onClick={() => claim(m.marketPda!, p.sideYes, m.id)}
                  >
                    {claiming === m.id ? 'Signing…' : voided ? 'Reclaim stake' : 'Claim winnings'}
                  </button>
                )}
              </div>
              {m.state === 'Settled' && <ReceiptView marketId={m.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
