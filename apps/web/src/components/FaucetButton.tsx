import { useState } from 'react';
import { AnchorProvider } from '@coral-xyz/anchor';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { faucetTx } from '@groundtruth/chain';
import { connection, oracleReadonly } from '../lib/solana.js';

/** Self-serve devnet USDT (spec §14 step 1) — user signs the faucet call. */
export default function FaucetButton() {
  const wallet = useAnchorWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    if (!wallet) return;
    setBusy(true);
    setMsg(null);
    try {
      // Fresh wallets have no devnet SOL to pay the faucet tx fee — try a
      // best-effort airdrop first so the button works for anyone.
      const lamports = await connection.getBalance(wallet.publicKey);
      if (lamports < 5_000_000) {
        setMsg('Requesting devnet SOL…');
        try {
          const sig = await connection.requestAirdrop(wallet.publicKey, 1_000_000_000);
          await connection.confirmTransaction(sig, 'confirmed');
        } catch {
          setMsg('Devnet SOL airdrop rate-limited — get SOL at faucet.solana.com first');
          return;
        }
      }
      const oracle = oracleReadonly(wallet);
      const { tx } = await faucetTx(connection, oracle, wallet.publicKey);
      const provider = oracle.provider as AnchorProvider;
      const sig = await provider.sendAndConfirm(tx);
      setMsg(`+100 USDT ✓ ${sig.slice(0, 8)}…`);
    } catch (err) {
      const s = String(err);
      setMsg(/RateLimit/.test(s) ? 'Faucet rate-limited — try later' : s.slice(0, 90));
    } finally {
      setBusy(false);
    }
  }

  if (!wallet) return null;
  return (
    <>
      <button className="ghost" disabled={busy} onClick={run} title="Get 100 devnet USDT">
        {busy ? 'Fauceting…' : '💧 Faucet'}
      </button>
      {msg && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{msg}</span>}
    </>
  );
}
