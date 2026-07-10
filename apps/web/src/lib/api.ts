/** Typed client for the Groundtruth backend API. */

export interface FixtureRow {
  fixtureId: number;
  competitionId: number;
  competition: string;
  home: string;
  away: string;
  homeIsP1: boolean;
  startTime: number;
  statusId: number | null;
  clockSeconds: number | null;
  scoreJson: string | null;
  lastSeq: number | null;
}

export interface HistoryPoint {
  ts: number;
  impliedYesBps: number;
  volume: number;
}

export interface MarketRow {
  id: string;
  fixtureId: number;
  slug: string;
  marketClass: 'A' | 'B' | 'C';
  question: string;
  yesLabel: string;
  noLabel: string;
  termsJson: string;
  termsHash: string;
  resolutionMethod: string;
  state: string;
  lockTs: number;
  resolveDeadlineTs: number;
  marketPda: string | null;
  yesPool: number;
  noPool: number;
  participantCount: number;
  winnerYes: boolean | null;
  disputeUntilTs: number | null;
}

export interface PositionRow {
  id: string;
  marketId: string;
  wallet: string;
  sideYes: boolean;
  amount: number;
  claimed: boolean;
  market?: MarketRow | null;
}

export interface ReceiptRow {
  marketId: string;
  fixtureId: number;
  evidenceTs: number;
  provenJson: string;
  rootDay: number;
  rootPda: string;
  resolveTx: string | null;
  proofJson: string;
  explanation: string;
  winnerYes: boolean;
  explorerUrl: string | null;
  rootPdaUrl: string;
}

export interface LeaderboardRow {
  wallet: string;
  realizedPnl: number;
  staked: number;
  wins: number;
  losses: number;
  verifiedWins: number;
}

/** Backend origin for deployed builds (Vite env); dev uses the vite proxy. */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '')
  .trim() // env values set via shell pipes can carry stray \r
  .replace(/\/+$/, '');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  fixtures: () => get<FixtureRow[]>('/api/fixtures'),
  markets: (params?: { fixtureId?: number; state?: string }) => {
    const q = new URLSearchParams();
    if (params?.fixtureId) q.set('fixtureId', String(params.fixtureId));
    if (params?.state) q.set('state', params.state);
    return get<MarketRow[]>(`/api/markets${q.size ? `?${q}` : ''}`);
  },
  market: (id: string) =>
    get<{ market: MarketRow; receipt: ReceiptRow | null; positions: PositionRow[] }>(
      `/api/markets/${encodeURIComponent(id)}`,
    ),
  receipt: (marketId: string) => get<ReceiptRow>(`/api/receipts/${encodeURIComponent(marketId)}`),
  history: (marketId: string) =>
    get<HistoryPoint[]>(`/api/markets/${encodeURIComponent(marketId)}/history`),
  walletPositions: (wallet: string) => get<PositionRow[]>(`/api/wallets/${wallet}/positions`),
  leaderboard: () => get<LeaderboardRow[]>('/api/leaderboard'),
  notifications: (wallet?: string) =>
    get<{ id: number; kind: string; payloadJson: string; createdAt: number }[]>(
      `/api/notifications${wallet ? `?wallet=${wallet}` : ''}`,
    ),
};

/** Live updates over the backend SSE stream. */
export function subscribeStream(handlers: {
  onScore?: (e: unknown) => void;
  onMarket?: (e: unknown) => void;
}): () => void {
  const es = new EventSource(`${API_BASE}/api/stream`);
  if (handlers.onScore) {
    es.addEventListener('score', (ev) => handlers.onScore!(JSON.parse((ev as MessageEvent).data)));
  }
  if (handlers.onMarket) {
    es.addEventListener('market', (ev) => handlers.onMarket!(JSON.parse((ev as MessageEvent).data)));
  }
  return () => es.close();
}
