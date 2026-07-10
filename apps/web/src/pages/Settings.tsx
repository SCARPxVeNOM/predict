import { useWallet } from '@solana/wallet-adapter-react';
import { DEVNET } from '@groundtruth/shared';

/** Real environment/config surface — nothing editable, nothing invented. */
export default function Settings() {
  const { publicKey } = useWallet();
  const rows: [string, string][] = [
    ['Network', 'Solana devnet (no real funds)'],
    ['RPC endpoint', DEVNET.rpcUrl],
    ['Pool program', 'B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537'],
    ['TxLINE oracle program', DEVNET.programId],
    ['Stake token', `devnet USDT ${DEVNET.usdtMint}`],
    ['Data feed', 'TxLINE free tier — World Cup + friendlies, ~60 s delayed'],
    ['Wallet', publicKey ? publicKey.toBase58() : 'not connected'],
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Settings</h2>
      </div>
      <div className="panel-sub">Environment this app is pinned to</div>
      <table className="lb">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ color: 'var(--muted)', width: 190 }}>{k}</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
