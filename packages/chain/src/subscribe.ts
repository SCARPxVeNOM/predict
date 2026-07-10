import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, SystemProgram } from '@solana/web3.js';
import { FREE_SERVICE_LEVEL_ID, SUBSCRIPTION_WEEKS } from '@groundtruth/shared';
import type { Txoracle } from './idl/txoracle.js';
import { TXL_MINT } from './program.js';
import { pricingMatrixPda, tokenTreasuryPda } from './pdas.js';

/**
 * On-chain `subscribe` for the free World Cup tier (service level 1, 0 TxL
 * charged). Ensures the user's TxL Token-2022 ATA exists first — the program
 * requires the account even when the price is zero.
 *
 * Returns the confirmed tx signature, which is the input to token activation.
 */
export async function subscribeFreeTier(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  user: Keypair,
  serviceLevelId: number = FREE_SERVICE_LEVEL_ID,
  weeks: number = SUBSCRIPTION_WEEKS,
): Promise<string> {
  if (weeks < 4 || weeks % 4 !== 0) {
    throw new Error(`weeks must be a positive multiple of 4, got ${weeks}`);
  }

  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT,
    user.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const preInstructions: anchor.web3.TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(userTokenAccount))) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        user.publicKey,
        userTokenAccount,
        user.publicKey,
        TXL_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  const treasuryPda = tokenTreasuryPda();
  const treasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT,
    treasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  return program.methods
    .subscribe(serviceLevelId, weeks)
    .preInstructions(preInstructions)
    .accounts({
      user: user.publicKey,
      pricingMatrix: pricingMatrixPda(),
      tokenMint: TXL_MINT,
      userTokenAccount,
      tokenTreasuryVault: treasuryVault,
      tokenTreasuryPda: treasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}
