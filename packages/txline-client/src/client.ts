import { EventSource } from 'eventsource';
import type { TxlineSession } from './session.js';
import type {
  Fixture,
  Scores,
  ScoresStatValidation,
  ScoresStatValidationV2,
  ScoresStreamMessage,
} from './types.js';

export interface ScoresStreamOptions {
  fixtureId?: number;
  lastEventId?: string;
  onMessage: (msg: ScoresStreamMessage) => void;
  onHeartbeat?: (ts: number) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Typed client for the TxLINE data API. All calls send `Authorization: Bearer <jwt>`
 * + `X-Api-Token`; on a 401 the guest JWT is renewed once and the call retried.
 */
export class TxlineClient {
  constructor(private readonly session: TxlineSession) {}

  private get api(): string {
    return `${this.session.origin}/api`;
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    const res = await fetch(`${this.api}${path}`, { headers: this.session.headers() });
    if (res.status === 401 && !retried) {
      await this.session.renewJwt();
      return this.get<T>(path, true);
    }
    if (!res.ok) {
      throw new TxlineApiError(res.status, path, await res.text());
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Some "historical" endpoints replay records as a finite SSE stream.
      return (await collectSseRecords(res, 4000)) as T;
    }
    return (await res.json()) as T;
  }

  /** Covered fixtures starting at/within 30 days after startEpochDay (default: today). */
  fixturesSnapshot(params?: { startEpochDay?: number; competitionId?: number }): Promise<Fixture[]> {
    const q = new URLSearchParams();
    if (params?.startEpochDay !== undefined) q.set('startEpochDay', String(params.startEpochDay));
    if (params?.competitionId !== undefined) q.set('competitionId', String(params.competitionId));
    const qs = q.size ? `?${q}` : '';
    return this.get<Fixture[]>(`/fixtures/snapshot${qs}`);
  }

  /** Latest (or as-of) per-action snapshots for a fixture. */
  scoresSnapshot(fixtureId: number, asOf?: number): Promise<Scores[]> {
    const qs = asOf !== undefined ? `?asOf=${asOf}` : '';
    return this.get<Scores[]>(`/scores/snapshot/${fixtureId}${qs}`);
  }

  /** All score updates for a fixture within the current 5-minute interval (incl. live). */
  scoresUpdates(fixtureId: number): Promise<Scores[]> {
    return this.get<Scores[]>(`/scores/updates/${fixtureId}`);
  }

  /** Full update sequence for a fixture that started 6h–2w ago (replay/demo source). */
  scoresHistorical(fixtureId: number): Promise<Scores[]> {
    return this.get<Scores[]>(`/scores/historical/${fixtureId}`);
  }

  /** Historical 5-minute interval batch (0-indexed interval within the hour). */
  scoresUpdatesInterval(
    epochDay: number,
    hourOfDay: number,
    interval: number,
    fixtureId?: number,
  ): Promise<Scores[]> {
    const qs = fixtureId !== undefined ? `?fixtureId=${fixtureId}` : '';
    return this.get<Scores[]>(`/scores/updates/${epochDay}/${hourOfDay}/${interval}${qs}`);
  }

  /** Legacy 1–2 stat proof payload for validate_stat / settle_* instructions. */
  statValidation(
    fixtureId: number,
    seq: number,
    statKey: number,
    statKey2?: number,
  ): Promise<ScoresStatValidation> {
    const q = new URLSearchParams({
      fixtureId: String(fixtureId),
      seq: String(seq),
      statKey: String(statKey),
    });
    if (statKey2 !== undefined) q.set('statKey2', String(statKey2));
    return this.get<ScoresStatValidation>(`/scores/stat-validation?${q}`);
  }

  /** V2 N-stat proof payload for validate_stat_v2. */
  statValidationV2(
    fixtureId: number,
    seq: number,
    statKeys: number[],
  ): Promise<ScoresStatValidationV2> {
    const q = new URLSearchParams({
      fixtureId: String(fixtureId),
      seq: String(seq),
      statKeys: statKeys.join(','),
    });
    return this.get<ScoresStatValidationV2>(`/scores/stat-validation?${q}`);
  }

  /** StablePrice odds snapshot (optional price-seeding surface). */
  oddsSnapshot(fixtureId: number, asOf?: number): Promise<unknown[]> {
    const qs = asOf !== undefined ? `?asOf=${asOf}` : '';
    return this.get<unknown[]>(`/odds/snapshot/${fixtureId}${qs}`);
  }

  /**
   * Long-lived scores SSE stream. Injects auth headers via a custom fetch and
   * renews the JWT transparently when the connection is rejected. The caller
   * owns the returned EventSource (call `.close()` to stop).
   */
  scoresStream(opts: ScoresStreamOptions): EventSource {
    const q = new URLSearchParams();
    if (opts.fixtureId !== undefined) q.set('fixtureId', String(opts.fixtureId));
    const url = `${this.api}/scores/stream${q.size ? `?${q}` : ''}`;

    const session = this.session;
    let lastEventId = opts.lastEventId;

    const es = new EventSource(url, {
      fetch: async (input, init) => {
        const attempt = () =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              ...session.headers(),
              ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
            },
          });
        let res = await attempt();
        if (res.status === 401 || res.status === 403) {
          await session.renewJwt();
          res = await attempt();
        }
        return res;
      },
    });

    es.onmessage = (event) => {
      lastEventId = event.lastEventId || lastEventId;
      try {
        const record = JSON.parse(event.data as string) as Scores;
        opts.onMessage({ lastEventId: event.lastEventId ?? '', record });
      } catch (err) {
        opts.onError?.(err);
      }
    };
    es.addEventListener('heartbeat', (event) => {
      try {
        const body = JSON.parse((event as MessageEvent).data as string) as { Ts?: number };
        opts.onHeartbeat?.(body.Ts ?? Date.now());
      } catch {
        opts.onHeartbeat?.(Date.now());
      }
    });
    if (opts.onOpen) es.onopen = opts.onOpen;
    if (opts.onError) es.onerror = opts.onError;
    return es;
  }
}

/**
 * Drain a finite SSE response into an array of `data:` JSON payloads.
 * Resolves when the server closes the stream or after `idleMs` without a new
 * chunk (replay endpoints may keep the connection open after the last record).
 */
async function collectSseRecords(res: Response, idleMs: number): Promise<unknown[]> {
  const body = res.body;
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const records: unknown[] = [];
  let buffer = '';

  const flushLines = () => {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) {
          try {
            records.push(JSON.parse(payload));
          } catch {
            // Non-JSON data lines (heartbeats etc.) are skipped.
          }
        }
      }
    }
  };

  try {
    for (;;) {
      const timeout = new Promise<'idle'>((r) => setTimeout(() => r('idle'), idleMs));
      const result = await Promise.race([reader.read(), timeout]);
      if (result === 'idle') break;
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      flushLines();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  flushLines();
  return records;
}

export class TxlineApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`TxLINE API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'TxlineApiError';
  }
}
