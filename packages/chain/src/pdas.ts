import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PROGRAM_ID } from './program.js';

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

const u16le = (n: number) => new BN(n).toArrayLike(Buffer, 'le', 2);
const u64le = (n: bigint | number) => new BN(n.toString()).toArrayLike(Buffer, 'le', 8);

export function pricingMatrixPda(): PublicKey {
  return pda([Buffer.from('pricing_matrix')]);
}

export function tokenTreasuryPda(): PublicKey {
  return pda([Buffer.from('token_treasury_v2')]);
}

export function usdtTreasuryPda(): PublicKey {
  return pda([Buffer.from('usdt_treasury')]);
}

/** Per-5-minute-batch scores roots for one UTC epoch day. */
export function dailyScoresRootsPda(epochDay: number): PublicKey {
  return pda([Buffer.from('daily_scores_roots'), u16le(epochDay)]);
}

export function dailyBatchRootsPda(epochDay: number): PublicKey {
  return pda([Buffer.from('daily_batch_roots'), u16le(epochDay)]);
}

export function tenDailyFixturesRootsPda(alignedEpochDayDiv10: number): PublicKey {
  return pda([Buffer.from('ten_daily_fixtures_roots'), u16le(alignedEpochDayDiv10)]);
}

/**
 * Confirmed empirically on devnet (tx FHVrdoXq…): seeds are
 * ["faucet_tracker", user pubkey].
 */
export function faucetTrackerPda(user: PublicKey): PublicKey {
  return pda([Buffer.from('faucet_tracker'), user.toBuffer()]);
}

/** @deprecated seed probing no longer needed; kept for the faucet helper API. */
export function faucetTrackerCandidates(user: PublicKey): PublicKey[] {
  return [faucetTrackerPda(user)];
}

/** Confirmed on devnet via simulated create_intent (2026-07-09). */
export function orderIntentPda(maker: PublicKey, intentId: bigint | number): PublicKey {
  return pda([Buffer.from('intent'), maker.toBuffer(), u64le(intentId)]);
}

/** Confirmed on devnet: seeds are ["intent_vault", order_intent PDA]. */
export function intentVaultPda(orderIntent: PublicKey): PublicKey {
  return pda([Buffer.from('intent_vault'), orderIntent.toBuffer()]);
}

/** Direct-trade escrow PDAs (documented in tx-on-chain README settle_trade example). */
export function tradeEscrowPda(tradeId: bigint | number): PublicKey {
  return pda([Buffer.from('escrow'), u64le(tradeId)]);
}
export function escrowVaultPda(tradeId: bigint | number): PublicKey {
  return pda([Buffer.from('escrow_vault'), u64le(tradeId)]);
}

/** Matched-trade PDA candidates (resolved empirically in the M2 round-trip). */
export function matchedTradePdaCandidates(tradeId: bigint | number): PublicKey[] {
  return [
    pda([Buffer.from('matched_trade'), u64le(tradeId)]),
    pda([Buffer.from('trade'), u64le(tradeId)]),
    pda([Buffer.from('match'), u64le(tradeId)]),
  ];
}
export function tradeVaultPda(matchedTrade: PublicKey): PublicKey {
  return pda([Buffer.from('trade_vault'), matchedTrade.toBuffer()]);
}

export { u16le, u64le };
