/** Smoke 2: guest JWT → on-chain subscribe (free tier) → activate API token. */
import { DEVNET } from '@groundtruth/shared';
import { subscribeFreeTier } from '@groundtruth/chain';
import { bootstrap, ensureSol, loadAuth, saveAuth } from './env.js';

const { keypair, connection, program, session, signer } = await bootstrap();
await ensureSol();

await session.renewJwt();
console.log(`Guest JWT acquired (${session.jwt.slice(0, 24)}…)`);

const txSig = await subscribeFreeTier(connection, program, keypair);
console.log(`subscribe(1, 4) confirmed: ${DEVNET.explorerTxUrl(txSig)}`);

const apiToken = await session.activate(txSig, [], signer);
console.log(`API token: ${apiToken.slice(0, 24)}…`);

saveAuth({ ...loadAuth(), jwt: session.jwt, apiToken, subscribeTxSig: txSig });
console.log('Auth state saved to .wallets/txline-auth.json');
