/**
 * All network-pinned constants live here and only here (spec §4).
 * The build targets Solana DEVNET exclusively — never mix networks.
 */
export const DEVNET = {
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
  txlMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
  usdtMint: 'ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh',
  apiOrigin: 'https://txline-dev.txodds.com',
  explorerTxUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  explorerAddressUrl: (addr: string) =>
    `https://explorer.solana.com/address/${addr}?cluster=devnet`,
} as const;

/** Free World Cup + International Friendlies tier (60s-delayed data). */
export const FREE_SERVICE_LEVEL_ID = 1;
/** Subscriptions are sold in 4-week blocks. */
export const SUBSCRIPTION_WEEKS = 4;
