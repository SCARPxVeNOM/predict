import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { Txoracle } from './idl/txoracle.js';
import { USDT_MINT } from './program.js';
import { faucetTrackerCandidates, usdtTreasuryPda } from './pdas.js';

/** Detect which token program owns a mint (devnet USDT could be classic or 2022). */
export async function tokenProgramForMint(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Unsigned faucet transaction for wallet-adapter users (browser flow). */
export async function faucetTx(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  user: PublicKey,
) {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  const usdtAta = getAssociatedTokenAddressSync(USDT_MINT, user, false, tokenProgram);
  const tx = await program.methods
    .requestDevnetFaucet()
    .accounts({
      user,
      faucetTracker: faucetTrackerCandidates(user)[0]!,
      usdtMint: USDT_MINT,
      userUsdtAta: usdtAta,
      usdtTreasuryPda: usdtTreasuryPda(),
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  return { tx, usdtAta };
}

/**
 * Devnet-only USDT faucet (rate-limited on-chain via FaucetTracker).
 * The faucet_tracker PDA seeds are undocumented, so candidate derivations are
 * simulated in order until one passes; wrong seeds fail fast with a
 * seeds-constraint error and cost nothing.
 */
export async function requestDevnetFaucet(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  user: Keypair,
): Promise<{ signature: string; usdtAta: PublicKey; faucetTracker: PublicKey }> {
  const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
  const usdtAta = getAssociatedTokenAddressSync(USDT_MINT, user.publicKey, false, tokenProgram);

  let lastError: unknown;
  for (const faucetTracker of faucetTrackerCandidates(user.publicKey)) {
    try {
      const signature = await program.methods
        .requestDevnetFaucet()
        .accounts({
          user: user.publicKey,
          faucetTracker,
          usdtMint: USDT_MINT,
          userUsdtAta: usdtAta,
          usdtTreasuryPda: usdtTreasuryPda(),
          tokenProgram,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      return { signature, usdtAta, faucetTracker };
    } catch (err) {
      lastError = err;
      const msg = String(err);
      // Seeds mismatch → try the next candidate; anything else is a real failure.
      if (!/ConstraintSeeds|seeds constraint|2006|InvalidPda/i.test(msg)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
