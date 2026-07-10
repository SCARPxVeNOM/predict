/**
 * Discover order_intent / intent_vault PDA seeds by simulating create_intent.
 * A failed `seeds constraint` logs the expected address (Left/Right), which we
 * match against candidate derivations offline.
 */
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { PublicKey, SystemProgram, Keypair } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PROGRAM_ID, USDT_MINT, tokenProgramForMint, tokenTreasuryPda } from '@groundtruth/chain';
import { bootstrap } from './env.js';

const { keypair, connection, program } = await bootstrap();

const intentId = new BN(123456789); // FIXED so seed-cracking (05c) can reproduce it
const idLe = intentId.toArrayLike(Buffer, 'le', 8);
const maker = keypair.publicKey;

const seedCandidates: [string, Buffer[]][] = [
  ['["order_intent", maker, id]', [Buffer.from('order_intent'), maker.toBuffer(), idLe]],
  ['["intent", maker, id]', [Buffer.from('intent'), maker.toBuffer(), idLe]],
  ['["order_intent", id]', [Buffer.from('order_intent'), idLe]],
  ['["intent", id]', [Buffer.from('intent'), idLe]],
  ['["order", maker, id]', [Buffer.from('order'), maker.toBuffer(), idLe]],
  ['["intent_vault", maker, id]', [Buffer.from('intent_vault'), maker.toBuffer(), idLe]],
  ['["intent_vault", id]', [Buffer.from('intent_vault'), idLe]],
  ['["vault", maker, id]', [Buffer.from('vault'), maker.toBuffer(), idLe]],
  ['["vault", id]', [Buffer.from('vault'), idLe]],
  ['["escrow", id]', [Buffer.from('escrow'), idLe]],
  ['["escrow_vault", id]', [Buffer.from('escrow_vault'), idLe]],
];

const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const lookup = new Map(seedCandidates.map(([label, seeds]) => [derive(seeds).toBase58(), label]));

const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
const makerAta = getAssociatedTokenAddressSync(USDT_MINT, maker, false, tokenProgram);

async function trySim(orderIntent: PublicKey, intentVault: PublicKey, label: string) {
  console.log(`\n--- simulate with ${label}`);
  console.log(`    order_intent=${orderIntent.toBase58()} vault=${intentVault.toBase58()}`);
  try {
    const termsHash = Array.from(new Uint8Array(32)); // placeholder
    const sim = await program.methods
      .createIntent(
        intentId,
        termsHash,
        new BN(1_000_000), // 1 USDT
        new BN(Math.floor(Date.now() / 1000) + 3600),
        5, // claim_period: F (soccer full time = 5)
        new BN(18209181), // France vs Morocco (upcoming)
      )
      .accounts({
        maker,
        orderIntent,
        intentVault,
        makerTokenAccount: makerAta,
        tokenMint: USDT_MINT,
        tokenTreasuryPda: tokenTreasuryPda(),
        tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .simulate();
    console.log('SIMULATION PASSED', sim.raw.slice(-5));
    return true;
  } catch (err: any) {
    const logs: string[] = err?.simulationResponse?.logs ?? err?.logs ?? [];
    for (const line of logs) console.log(`    ${line}`);
    // Anchor seeds-constraint failures log Left (expected) / Right (provided).
    for (const line of logs) {
      const m = line.match(/(?:Left|Right):\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (m) {
        const addr = m[1]!;
        const hit = lookup.get(addr);
        console.log(`    >>> logged address ${addr} ${hit ? `MATCHES ${hit}` : '(no candidate match)'}`);
      }
    }
    return false;
  }
}

const intentPda = derive([Buffer.from('intent'), maker.toBuffer(), idLe]);
const vaultGuesses: [string, PublicKey][] = [
  ['["intent_vault", maker, id]', derive([Buffer.from('intent_vault'), maker.toBuffer(), idLe])],
  ['["intent_vault", intentPda]', derive([Buffer.from('intent_vault'), intentPda.toBuffer()])],
  ['["vault", intentPda]', derive([Buffer.from('vault'), intentPda.toBuffer()])],
  ['["intent_vault", id]', derive([Buffer.from('intent_vault'), idLe])],
];
for (const [label, vault] of vaultGuesses) {
  const ok = await trySim(intentPda, vault, `intent=["intent",maker,id], vault=${label}`);
  if (ok) break;
}
