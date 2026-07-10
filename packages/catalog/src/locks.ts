import { SOCCER_STATUS } from './status.js';
import type { LockRuleName } from './templates.js';

/**
 * Lock rules (spec §5.1): the free tier delivers data ~60s delayed, so no
 * market may accept positions once the information edge could exist.
 * Conservative default: everything locks at kickoff.
 */
export interface LockDecisionInput {
  now: number;
  startTime: number;
  statusId: number | undefined;
}

export function isLocked(rule: LockRuleName, i: LockDecisionInput): boolean {
  switch (rule) {
    case 'kickoff':
      // Lock 2 minutes before scheduled start, or the moment the feed shows
      // any status beyond NS — whichever comes first.
      return (
        i.now >= i.startTime - 2 * 60_000 ||
        (i.statusId !== undefined && i.statusId !== SOCCER_STATUS.NS)
      );
    case 'periodStart':
      // Second-half-scoped markets could stay open through H1… but with a 60s
      // delay the honest default is still kickoff. Kept as a named rule so a
      // future real-time tier can relax it in one place.
      return isLocked('kickoff', i);
    case 'never-inplay':
      return isLocked('kickoff', i);
  }
}
