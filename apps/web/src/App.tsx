import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import FaucetButton from './components/FaucetButton.js';
import RightRail from './components/RightRail.js';
import Live from './pages/Live.js';
import Predictions from './pages/Predictions.js';
import Profile from './pages/Profile.js';
import Leaderboard from './pages/Leaderboard.js';
import Activity from './pages/Activity.js';
import Settings from './pages/Settings.js';

type Tab = 'live' | 'predictions' | 'leaderboard' | 'portfolio' | 'activity' | 'settings';

const NAV: { key: Tab; icon: string; label: string; live?: boolean }[] = [
  { key: 'live', icon: '⚡', label: 'Live Markets', live: true },
  { key: 'predictions', icon: '🗓️', label: 'Predictions' },
  { key: 'leaderboard', icon: '🏆', label: 'Leaderboard' },
  { key: 'portfolio', icon: '📊', label: 'Portfolio' },
  { key: 'activity', icon: '〰️', label: 'Activity' },
  { key: 'settings', icon: '⚙️', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [search, setSearch] = useState('');

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-ball">⚽</div>
          <div className="brand-name">
            World Cup
            <br />
            Markets
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`navbtn ${tab === n.key ? 'active' : ''}`}
            onClick={() => setTab(n.key)}
          >
            <span>{n.icon}</span> {n.label}
            {n.live && <span className="live-pill">LIVE</span>}
          </button>
        ))}
        <div className="sidebar-foot">
          <a
            className="howitworks"
            style={{ textDecoration: 'none' }}
            href="https://txline.txodds.com/documentation/quickstart"
            target="_blank"
            rel="noreferrer"
          >
            ❓ How it works
          </a>
        </div>
      </aside>

      <div className="aurora" />
      <main className="maincol">
        <div className="hero">
          <div style={{ flex: 1 }}>
            <h1>FIFA World Cup 2026</h1>
            <div className="sub">Predict. Trade. Win. — every result provable on-chain.</div>
          </div>
          <div className="searchbox">
            <span>🔍</span>
            <input
              placeholder="Search markets, teams…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <FaucetButton />
          <div className="walletbtn-wrap">
            <WalletMultiButton />
          </div>
        </div>

        {tab === 'live' ? (
          <div className="content-grid">
            <div>
              <Live search={search} />
            </div>
            <RightRail onNav={(t) => setTab(t as Tab)} />
          </div>
        ) : (
          <>
            {tab === 'predictions' && <Predictions />}
            {tab === 'leaderboard' && <Leaderboard />}
            {tab === 'portfolio' && <Profile />}
            {tab === 'activity' && <Activity />}
            {tab === 'settings' && <Settings />}
          </>
        )}

        <div className="footer">
          © 2026 World Cup Markets · Solana devnet · settlement proofs by TxLINE — no mock data,
          every number on this page is on-chain or from the licensed feed.
          <br />
          Stadium photo by YoTuT (CC BY 2.0, Wikimedia Commons) · flags from flagcdn.com (public
          domain)
        </div>
      </main>
    </div>
  );
}
