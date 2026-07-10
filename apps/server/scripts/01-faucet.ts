/** Smoke 1: SOL airdrop (if needed) + devnet USDT faucet. */
import { getAccount } from '@solana/spl-token';
import { DEVNET } from '@groundtruth/shared';
import { requestDevnetFaucet, tokenProgramForMint, USDT_MINT } from '@groundtruth/chain';
import { bootstrap, ensureSol } from './env.js';

const { keypair, connection, program } = await bootstrap();
await ensureSol();

const result = await requestDevnetFaucet(connection, program, keypair);
console.log(`Faucet tx: ${DEVNET.explorerTxUrl(result.signature)}`);
console.log(`faucet_tracker PDA that worked: ${result.faucetTracker.toBase58()}`);

const tokenProgram = await tokenProgramForMint(connection, USDT_MINT);
const account = await getAccount(connection, result.usdtAta, 'confirmed', tokenProgram);
console.log(`USDT balance: ${Number(account.amount) / 1e6} (ata ${result.usdtAta.toBase58()})`);
