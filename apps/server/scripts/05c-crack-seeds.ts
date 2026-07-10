/**
 * Offline brute force for the order_intent PDA seeds against the expected
 * address logged by the program (05b, fixed args):
 *   maker=keeper, intent_id=123456789, fixture_id=18209181,
 *   terms_hash=zero32, deposit=1_000_000, claim_period=5.
 */
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '@groundtruth/chain';
import { loadOrCreateKeypair } from './env.js';

const TARGET = process.argv[2] ?? '9orH3a21zcYx32Xh3HX57tnZWrEaqCXk2bJgZ6dDm6oR';
const maker = loadOrCreateKeypair().publicKey;

const idBn = new BN(123456789);
const fixtureBn = new BN(18209181);

const parts: Record<string, Buffer> = {
  maker: maker.toBuffer(),
  idLe: idBn.toArrayLike(Buffer, 'le', 8),
  idBe: idBn.toArrayLike(Buffer, 'be', 8),
  idLe4: idBn.toArrayLike(Buffer, 'le', 4),
  idStr: Buffer.from('123456789'),
  fixLe: fixtureBn.toArrayLike(Buffer, 'le', 8),
  fixBe: fixtureBn.toArrayLike(Buffer, 'be', 8),
  fixLe4: fixtureBn.toArrayLike(Buffer, 'le', 4),
  hash0: Buffer.alloc(32),
  depLe: new BN(1_000_000).toArrayLike(Buffer, 'le', 8),
  claimLe: new BN(5).toArrayLike(Buffer, 'le', 2),
};

const prefixes = [
  '', 'order_intent', 'intent', 'order', 'oi', 'intent_account', 'user_intent',
  'maker_intent', 'trade_intent', 'offer', 'orderbook', 'ob', 'intent_state',
  'market', 'position', 'bet', 'prediction', 'intents', 'orders', 'order_v1',
  'intent_v2', 'oracle_intent',
];

const names = Object.keys(parts);
const perms: string[][] = [[]];
for (const a of names) {
  perms.push([a]);
  for (const b of names) {
    if (b === a) continue;
    perms.push([a, b]);
    for (const c of names) {
      if (c === a || c === b) continue;
      perms.push([a, b, c]);
    }
  }
}
console.log(`Testing ${prefixes.length * perms.length} derivations...`);

let found = 0;
for (const prefix of prefixes) {
  for (const combo of perms) {
    const seeds = [
      ...(prefix ? [Buffer.from(prefix)] : []),
      ...combo.map((c) => parts[c]!),
    ];
    if (!seeds.length) continue;
    try {
      const [addr] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
      if (addr.toBase58() === TARGET) {
        console.log(`MATCH: prefix="${prefix}" components=[${combo.join(', ')}]`);
        found++;
      }
    } catch {
      /* seed too long */
    }
  }
}
if (!found) console.log('Still no match.');
