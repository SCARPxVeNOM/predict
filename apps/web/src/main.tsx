import { Buffer } from 'buffer';
// web3.js / anchor expect a global Buffer in the browser.
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { DEVNET } from '@groundtruth/shared';
import App from './App.js';
import './styles.css';
import '@solana/wallet-adapter-react-ui/styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 15_000, staleTime: 5_000 } },
});

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={DEVNET.rpcUrl}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <App />
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Root />);
