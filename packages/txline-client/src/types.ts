/**
 * TxLINE off-chain API shapes.
 *
 * IMPORTANT: the OpenAPI spec (docs.yaml) describes Scores records in camelCase,
 * but the real wire format is PascalCase with a numeric StatusId — these types
 * were transcribed from live devnet responses (fixture 18202783, 2026-07-09).
 * Fixtures and stat-validation payloads DO match the spec (PascalCase and
 * camelCase respectively).
 */

export interface Fixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

/** Per-period aggregate soccer stats. Zero-valued fields are omitted on the wire. */
export interface SoccerScore {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

export interface SoccerTotalScore {
  H1?: SoccerScore;
  HT?: SoccerScore;
  H2?: SoccerScore;
  ET1?: SoccerScore;
  ET2?: SoccerScore;
  PE?: SoccerScore;
  ETTotal?: SoccerScore;
  Total?: SoccerScore;
}

/** Action payload details (soccer): goal/card/corner flags, player ids, etc. */
export interface ScoresData {
  Action?: string;
  Goal?: boolean;
  GoalType?: string;
  Corner?: boolean;
  YellowCard?: boolean;
  RedCard?: boolean;
  VAR?: boolean;
  Penalty?: boolean;
  Minutes?: number;
  Outcome?: string;
  Participant?: number;
  PlayerId?: number;
  PlayerInId?: number;
  PlayerOutId?: number;
  StatusId?: number;
  Type?: string;
  [k: string]: unknown;
}

/** A single scores feed record (one action message), real wire shape. */
export interface Scores {
  FixtureId: number;
  GameState: string;
  StartTime: number;
  IsTeam: boolean;
  FixtureGroupId: number;
  CompetitionId: number;
  CountryId: number;
  SportId: number;
  Participant1IsHome: boolean;
  Participant1Id: number;
  Participant2Id: number;
  CoverageSecondaryData?: boolean;
  CoverageType?: string;
  Action: string;
  Id: number;
  Ts: number;
  ConnectionId: number;
  Seq: number;
  /** Numeric soccer status id (see catalog/status.ts for the mapping). */
  StatusId?: number;
  Type?: string;
  Confirmed?: boolean;
  Clock?: { Running: boolean; Seconds: number };
  Score?: { Participant1: SoccerTotalScore; Participant2: SoccerTotalScore };
  Data?: ScoresData;
  /**
   * Full provable stat map keyed by on-chain stat key
   * (base 1–8, +1000·period) → value. Present on most records.
   */
  Stats?: Record<string, number>;
  Participant?: number;
  Possession?: number;
  PossibleEvent?: Record<string, unknown>;
  PlayerStats?: {
    Participant1?: Record<string, Record<string, number>>;
    Participant2?: Record<string, Record<string, number>>;
  };
  Lineups?: unknown[];
  [k: string]: unknown;
}

/** Merkle proof node as returned by the API (hash arrives as a byte array). */
export interface ApiProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface ScoreStat {
  key: number;
  value: number;
  period: number;
}

export interface ScoresUpdateStats {
  updateCount: number;
  minTimestamp: number;
  maxTimestamp: number;
}

export interface ScoresBatchSummary {
  fixtureId: number;
  updateStats: ScoresUpdateStats;
  eventStatsSubTreeRoot: number[];
}

/** Legacy mode (statKey / statKey2) response. */
export interface ScoresStatValidation {
  ts: number;
  statToProve: ScoreStat;
  eventStatRoot: number[];
  summary: ScoresBatchSummary;
  statProof: ApiProofNode[];
  subTreeProof: ApiProofNode[];
  mainTreeProof: ApiProofNode[];
  statToProve2?: ScoreStat;
  statProof2?: ApiProofNode[];
}

/** V2 mode (statKeys=comma,list) response — N stats in one payload. */
export interface ScoresStatValidationV2 {
  ts: number;
  statsToProve: ScoreStat[];
  eventStatRoot: number[];
  summary: ScoresBatchSummary;
  statProofs: ApiProofNode[][];
  subTreeProof: ApiProofNode[];
  mainTreeProof: ApiProofNode[];
}

export interface ScoresStreamMessage {
  /** SSE event id in `timestamp:index` form; used for Last-Event-ID resume. */
  lastEventId: string;
  record: Scores;
}
