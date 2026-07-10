import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { api } from '../lib/api.js';
import { shortAddr } from '../lib/format.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export default function RightRail({ onNav }: { onNav: (tab: string) => void }) {
  const { publicKey } = useWallet();
  const { data: traders = [] } = useQuery({ queryKey: ['leaderboard'], queryFn: api.leaderboard });
  const top = traders.slice(0, 5);
  const myRank = publicKey
    ? traders.findIndex((t) => t.wallet === publicKey.toBase58()) + 1 || null
    : null;

  return (
    <div className="rail">
      {!publicKey && (
        <div className="panel cta">
          <div className="trophy">🏆</div>
          <h3>Connect your wallet</h3>
          <p>Trade on live devnet markets and make provable predictions to win</p>
          <div className="walletbtn-wrap" style={{ display: 'flex', justifyContent: 'center' }}>
            <WalletMultiButton />
          </div>
        </div>
      )}

      <div className="panel">
        <h4>
          Top Traders
          <span className="view-all" onClick={() => onNav('leaderboard')}>
            View full leaderboard
          </span>
        </h4>
        <div className="traders">
          {top.length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '8px 0' }}>
              No settled markets yet — rankings appear after the first on-chain settlement.
            </div>
          )}
          {top.map((t, i) => (
            <div className="trader-row" key={t.wallet}>
              <span className="rank">{i + 1}</span>
              <span className="medal">{MEDALS[i] ?? ''}</span>
              <span className="addr mono">{shortAddr(t.wallet)}</span>
              <span className={`pnl ${t.realizedPnl >= 0 ? 'pos' : 'neg'}`}>
                {t.realizedPnl >= 0 ? '+' : ''}
                {t.realizedPnl.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>
          Your Rank{' '}
          <b style={{ float: 'right', color: 'var(--text)' }}>
            {publicKey ? (myRank ? `#${myRank}` : 'unranked') : 'connect wallet'}
          </b>
        </div>
      </div>

      <div className="panel">
        <h4>Quick Links</h4>
        <div className="quick">
          <a href="https://txline.txodds.com/documentation/quickstart" target="_blank" rel="noreferrer">
            ❓ How it works <span className="chev">›</span>
          </a>
          <a
            href="https://explorer.solana.com/address/B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537?cluster=devnet"
            target="_blank"
            rel="noreferrer"
          >
            📜 Pool program on-chain <span className="chev">›</span>
          </a>
          <a
            href="https://explorer.solana.com/address/6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J?cluster=devnet"
            target="_blank"
            rel="noreferrer"
          >
            🔮 TxLINE oracle program <span className="chev">›</span>
          </a>
        </div>
      </div>
    </div>
  );
}
