import { EventEmitter } from 'node:events';

/** In-process fan-out from services to the SSE API (score/market/leaderboard events). */
export const bus = new EventEmitter();
bus.setMaxListeners(500);
