import { TxlineClient, TxlineSession, keypairSigner } from '@groundtruth/txline-client';
import { createConnection, createProgram, subscribeFreeTier, type Txoracle } from '@groundtruth/chain';
import type { Program } from '@coral-xyz/anchor';
import type { Connection, Keypair } from '@solana/web3.js';
import { loadAuthFile, loadKeeper, saveAuthFile } from '../config.js';

export interface Ctx {
  keeper: Keypair;
  connection: Connection;
  oracle: Program<Txoracle>;
  session: TxlineSession;
  txline: TxlineClient;
}

/**
 * Build the shared server context: keeper wallet, oracle program handle, and
 * an activated TxLINE session (re-subscribing on-chain if the stored API
 * token no longer works).
 */
export async function buildContext(): Promise<Ctx> {
  const keeper = loadKeeper();
  const connection = createConnection();
  const oracle = createProgram(connection, keeper);

  const session = new TxlineSession();
  const saved = loadAuthFile();
  if (saved.jwt) session.jwt = saved.jwt;
  if (saved.apiToken) session.apiToken = saved.apiToken;
  const txline = new TxlineClient(session);

  // Probe access; renew JWT and, if still forbidden, redo subscribe+activate.
  try {
    await txline.fixturesSnapshot({});
  } catch {
    console.log('[txline] stored auth invalid — refreshing');
    await session.renewJwt();
    try {
      await txline.fixturesSnapshot({});
    } catch {
      console.log('[txline] re-subscribing on-chain (free tier)');
      const txSig = await subscribeFreeTier(connection, oracle, keeper);
      await session.activate(txSig, [], keypairSigner(keeper.secretKey));
      saveAuthFile({ jwt: session.jwt, apiToken: session.apiToken, subscribeTxSig: txSig });
    }
  }
  saveAuthFile({ jwt: session.jwt, apiToken: session.apiToken, subscribeTxSig: saved.subscribeTxSig });

  return { keeper, connection, oracle, session, txline };
}
