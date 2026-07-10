import { useState } from 'react';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import type { FixtureRow, MarketRow } from '../lib/api.js';
import { decimalOdds, minuteChip, usdt } from '../lib/format.js';
import { sendDeposit } from '../lib/solana.js';
import Sparkline from './Sparkline.js';
import ReceiptView from './ReceiptView.js';

export default function MarketCard({
  m,
  fixture,
  hot,
}: {
  m: MarketRow;
  fixture?: FixtureRow;
  hot?: boolean;
}) {
  const wallet = useAnchorWallet();
  const [stake, setStake] = useState('5');
  const [side, setSide] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const open = m.state === 'Open';
  const odds = decimalOdds(m);
  const minute = fixture ? minuteChip(fixture) : null;
  const vol = m.yesPool + m.noPool;

  async function trade() {
    if (!wallet || side === null || !m.marketPda) return;
    setBusy(true);
    setMsg(null);
    try {
      const sig = await sendDeposit(wallet, m.marketPda, side, Number(stake));
      setMsg(`On-chain ✓ ${sig.slice(0, 10)}…`);
      setSide(null);
    } catch (err) {
      setMsg(String(err).slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcard">
      <div className="mcard-top">
        {minute && <span className="minute-chip">{minute}</span>}
        {vol > 0 && (
          <span className={`tag-chip ${hot ? 'hot' : ''}`}>{hot ? '🔥 Hot' : '📈 Trending'}</span>
        )}
        <span className={`class-chip ${m.marketClass}`} title={m.resolutionMethod}>
          {m.marketClass === 'A' ? 'CHAIN-VERIFIED' : 'FEED-RESOLVED'}
        </span>
      </div>

      <div className="mcard-q">
        {m.question}
        {fixture && (
          <small>
            {fixture.home} vs {fixture.away}
          </small>
        )}
      </div>

      <Sparkline marketId={m.id} />

      <div className="oddsrow">
        <button
          className={`oddbtn yes ${side === true ? 'picked' : ''}`}
          disabled={!open || !m.marketPda}
          onClick={() => setSide(true)}
        >
          <span className="side-l">{m.yesLabel}</span>
          <span className="odd-v">{odds.yes}</span>
        </button>
        <button
          className={`oddbtn no ${side === false ? 'picked' : ''}`}
          disabled={!open || !m.marketPda}
          onClick={() => setSide(false)}
        >
          <span className="side-l">{m.noLabel}</span>
          <span className="odd-v">{odds.no}</span>
        </button>
      </div>

      {side !== null && open && (
        <div className="stakebar">
          <input type="number" min={1} value={stake} onChange={(e) => setStake(e.target.value)} />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>USDT</span>
          <button className="primary" disabled={busy || !wallet} onClick={trade}>
            {busy ? 'Signing…' : wallet ? 'Place' : 'Connect wallet'}
          </button>
        </div>
      )}
      {msg && <div className="mini-note">{msg}</div>}

      <div className="mcard-foot">
        <span>
          {usdt(vol)} USDT Vol. · 👥 {m.participantCount}
        </span>
        <span className={`state-chip ${m.state}`}>{m.state}</span>
      </div>

      {m.state === 'Settled' && (
        <>
          <div className="mcard-foot">
            <span>
              Winner:{' '}
              <b style={{ color: m.winnerYes ? 'var(--yes)' : 'var(--no)' }}>
                {m.winnerYes ? m.yesLabel : m.noLabel}
              </b>
            </span>
            <button className="ghost" onClick={() => setShowReceipt((v) => !v)}>
              {showReceipt ? 'Hide receipt' : 'Receipt'}
            </button>
          </div>
          {showReceipt && <ReceiptView marketId={m.id} />}
        </>
      )}
    </div>
  );
}
