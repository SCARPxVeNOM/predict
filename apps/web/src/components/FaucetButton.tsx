import { useState } from 'react';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { useAnchorWallet } from '@solana/wallet-adapter-react';
import { Keypair } from '@solana/web3.js';
import { createProgram, faucetTx, type Txoracle } from '@groundtruth/chain';
import { connection } from '../lib/solana.js';

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
      const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
      const base = createProgram(connection, Keypair.generate());
      const oracle = new Program<Txoracle>(base.idl, provider);
      const { tx } = await faucetTx(connection, oracle, wallet.publicKey);
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
