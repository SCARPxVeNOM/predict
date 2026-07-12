import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MarketRow, type FixtureRow } from '../lib/api.js';
import { flagSrc } from '../lib/flags.js';
import ReceiptView from '../components/ReceiptView.js';

/**
 * Proof gallery (hackathon review): every Class-A market that settled
 * on-chain, with its verification receipt and a browser-side Re-verify that
 * re-runs TxLINE's validate_stat against the same posted root — proving each
 * past outcome without trusting this server.
 */
export default function Proofs() {
  const { data: markets = [] } = useQuery({ queryKey: ['markets'], queryFn: () => api.markets() });
  const { data: fixtures = [] } = useQuery({ queryKey: ['fixtures'], queryFn: () => api.fixtures() });
  const fx = new Map(fixtures.map((f) => [f.fixtureId, f]));

  // Chain-verified settlements: Class-A, settled, with an on-chain pool.
  const settled = markets
    .filter((m) => m.state === 'Settled' && m.marketClass === 'A' && m.marketPda)
    .sort((a, b) => b.fixtureId - a.fixtureId || a.slug.localeCompare(b.slug));

  // Group by fixture for readability.
  const byFixture = new Map<number, MarketRow[]>();
  for (const m of settled) {
    const arr = byFixture.get(m.fixtureId) ?? [];
    arr.push(m);
    byFixture.set(m.fixtureId, arr);
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Proofs &amp; Verification</h2>
      </div>
      <div className="panel-sub">
        Every market below settled on-chain via a TxLINE Merkle proof against the posted daily
        scores root. Expand any card to read its receipt — the proven stat, the root PDA, the
        settlement transaction — and press <b>Re-verify yourself</b> to re-run the on-chain
        validation from your own browser. No trust in this server required.
      </div>

      {!settled.length ? (
        <div className="empty">
          Chain-verified settlements appear here as markets resolve. (Regulation and extra-time /
          penalty matches both settle by proof.)
        </div>
      ) : (
        <>
          <div className="proof-summary">
            <span>
              <b>{settled.length}</b> chain-verified settlements
            </span>
            <span>
              <b>{byFixture.size}</b> matches
            </span>
          </div>
          {[...byFixture.entries()].map(([fixtureId, rows]) => {
            const f = fx.get(fixtureId);
            return (
              <div key={fixtureId} className="proof-group">
                {f && (
                  <h3 className="proof-match">
                    {flagSrc(f.home) && <img className="flag" src={flagSrc(f.home)!} alt="" />}{' '}
                    {f.home} vs {f.away}{' '}
                    {flagSrc(f.away) && <img className="flag" src={flagSrc(f.away)!} alt="" />}
                  </h3>
                )}
                {rows.map((m) => (
                  <ProofRow key={m.id} m={m} fixture={f} />
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function ProofRow({ m, fixture }: { m: MarketRow; fixture?: FixtureRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="proof-row">
      <div className="proof-head">
        <div className="proof-q">
          {m.question}
          <span className="proof-outcome">
            {' '}
            →{' '}
            <b style={{ color: m.winnerYes ? 'var(--yes)' : 'var(--no)' }}>
              {m.winnerYes ? m.yesLabel : m.noLabel}
            </b>
          </span>
        </div>
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide proof' : '🔎 View proof & re-verify'}
        </button>
      </div>
      {open && <ReceiptView marketId={m.id} />}
    </div>
  );
}
