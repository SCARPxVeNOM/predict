/**
 * Reverse-engineer intent/trade PDA seeds by scanning recent txoracle
 * transactions on devnet for create_intent / execute_match calls, decoding
 * their instruction data, and testing candidate seed derivations against the
 * actual account addresses used.
 */
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, createConnection } from '@groundtruth/chain';
import idl from '../../../packages/chain/src/idl/txoracle.json' with { type: 'json' };

const connection = createConnection();
const coder = new anchor.BorshInstructionCoder(idl as anchor.Idl);

const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 1000 });
console.log(`Scanned ${sigs.length} recent txoracle transactions`);

const wanted = new Set(['create_intent', 'execute_match', 'settle_matched_trade', 'close_intent']);
let found = 0;

for (const s of sigs) {
  if (found >= 6) break;
  if (s.err) continue;
  const tx = await connection.getTransaction(s.signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? [];
  for (const ix of msg.compiledInstructions ?? []) {
    if (!keys[ix.programIdIndex]?.equals(PROGRAM_ID)) continue;
    let decoded: { name: string; data: unknown } | null = null;
    try {
      decoded = coder.decode(Buffer.from(ix.data));
    } catch {
      continue;
    }
    if (!decoded || !wanted.has(decoded.name)) continue;
    found++;
    console.log(`\n=== ${decoded.name} in ${s.signature} ===`);
    const accountKeys = ix.accountKeyIndexes.map((i) => keys[i]!);
    accountKeys.forEach((k, i) => console.log(`  acct[${i}] ${k.toBase58()}`));
    const data = decoded.data as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      const shown =
        v instanceof BN || (v as any)?.toString ? String(v) : JSON.stringify(v);
      console.log(`  arg ${k} = ${shown.slice(0, 80)}`);
    }

    if (decoded.name === 'create_intent') {
      const maker = accountKeys[0]!;
      const intentId = new BN(String(data.intentId ?? data.intent_id));
      const idLe = intentId.toArrayLike(Buffer, 'le', 8);
      const candidates: Record<string, Buffer[][]> = {
        order_intent: [
          [Buffer.from('order_intent'), maker.toBuffer(), idLe],
          [Buffer.from('intent'), maker.toBuffer(), idLe],
          [Buffer.from('order_intent'), idLe],
          [Buffer.from('intent'), idLe],
        ],
        intent_vault: [
          [Buffer.from('intent_vault'), maker.toBuffer(), idLe],
          [Buffer.from('intent_vault'), idLe],
          [Buffer.from('vault'), maker.toBuffer(), idLe],
        ],
      };
      for (const [slot, seedSets] of Object.entries(candidates)) {
        const target = slot === 'order_intent' ? accountKeys[1]! : accountKeys[2]!;
        for (const seeds of seedSets) {
          const [derived] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
          if (derived.equals(target)) {
            console.log(
              `  >>> ${slot} seeds = [${seeds.map((b) => (b.length <= 16 ? JSON.stringify(b.toString()) : 'pubkey/u64')).join(', ')}]`,
            );
          }
        }
      }
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

if (!found) console.log('No intent/trade transactions found in recent history.');
