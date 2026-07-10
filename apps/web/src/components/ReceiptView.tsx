import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { api } from '../lib/api.js';
import { reverify } from '../lib/solana.js';

/**
 * The verification receipt (spec §9): proven stat, root, explorer link, and a
 * Re-verify button that re-runs validate_stat read-only from THIS browser —
 * no trust in the Groundtruth backend required.
 */
export default function ReceiptView({ marketId }: { marketId: string }) {
  const wallet = useAnchorWallet();
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: receipt, isPending, isError } = useQuery({
    queryKey: ['receipt', marketId],
    queryFn: () => api.receipt(marketId),
    retry: 1,
    refetchInterval: (q) => (q.state.data ? false : 30_000),
  });

  if (isPending) return <div className="receipt">Loading receipt…</div>;
  if (isError || !receipt) {
    return (
      <div className="receipt">
        🧾 The receipt for this market is being regenerated from the on-chain proof — it appears
        here automatically within a minute or two. The settlement itself is already final
        on-chain.
      </div>
    );
  }
  const proven = JSON.parse(receipt.provenJson) as {
    statA: { key: number; value: number; period: number };
    statB: { key: number; value: number; period: number } | null;
    predicate: { threshold: number; comparison: string };
    op: string | null;
  };

  async function onReverify() {
    if (!wallet || !receipt) return;
    setVerifying(true);
    setError(null);
    try {
      const ok = await reverify(wallet, receipt.proofJson, proven.predicate, proven.op);
      setResult(ok);
    } catch (err) {
      setError(String(err).slice(0, 160));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="receipt">
      <div className="expl">🧾 {receipt.explanation}</div>
      <div>
        Proven: stat {proven.statA.key} = <b>{proven.statA.value}</b>
        {proven.statB && (
          <>
            {' '}· stat {proven.statB.key} = <b>{proven.statB.value}</b>
          </>
        )}{' '}
        · {proven.op ?? 'single'} {proven.predicate.comparison} {proven.predicate.threshold}
      </div>
      <div className="mono">root PDA (epoch day {receipt.rootDay}): {receipt.rootPda}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {receipt.explorerUrl && (
          <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">
            Settlement tx ↗
          </a>
        )}
        <a href={receipt.rootPdaUrl} target="_blank" rel="noreferrer">
          On-chain root ↗
        </a>
        <button className="ghost" disabled={verifying || !wallet} onClick={onReverify}>
          {verifying ? 'Verifying on-chain…' : wallet ? 'Re-verify yourself' : 'Connect wallet to re-verify'}
        </button>
        {result !== null && (
          <span className={`verify-result ${result ? 'ok' : 'bad'}`}>
            {result ? '✓ proof valid on-chain' : '✗ predicate false'}
          </span>
        )}
        {error && <span style={{ color: 'var(--no)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}
