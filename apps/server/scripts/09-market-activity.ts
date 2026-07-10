/** Gauge devnet market activity: intent states + matched trades + escrows. */
import { bootstrap } from './env.js';

const { program } = await bootstrap();

const intents = await program.account.orderIntent.all();
const byState = new Map<string, number>();
for (const { account } of intents) {
  const s = Object.keys(account.state as object)[0]!;
  byState.set(s, (byState.get(s) ?? 0) + 1);
}
console.log(`OrderIntents: ${intents.length}`, Object.fromEntries(byState));

const matched = await program.account.matchedTrade.all();
console.log(`MatchedTrades: ${matched.length}`);
for (const { publicKey, account } of matched.slice(0, 10)) {
  console.log(
    `  ${publicKey.toBase58()} id=${account.tradeId} state=${JSON.stringify(account.state)} ` +
      `maker=${account.maker.toBase58().slice(0, 8)} taker=${account.taker.toBase58().slice(0, 8)}`,
  );
}

const escrows = await program.account.tradeEscrow.all();
console.log(`TradeEscrows (direct create_trade): ${escrows.length}`);
for (const { publicKey, account } of escrows.slice(0, 10)) {
  console.log(
    `  ${publicKey.toBase58()} id=${account.tradeId} state=${JSON.stringify(account.state)} ` +
      `stakes=${account.stakeA}/${account.stakeB}`,
  );
}
