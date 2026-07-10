/**
 * Long-horizon Class-C (composed) markets — group qualification, bracket,
 * champion. Resolved from per-match on-chain proofs + a public deterministic
 * rule set. Ships after the Class-A live loop (spec fenced this as the last
 * milestone); until then this surface documents the method honestly.
 */
export default function Predictions() {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Predictions</h2>
      </div>
      <div className="notice">
        <b>Composed markets (Class C)</b> resolve from many per-match on-chain proofs plus a
        published deterministic rule (group points → goal difference → goals scored →
        head-to-head). Every <i>input</i> is chain-verifiable; the aggregation rule is public.
      </div>
      <div className="empty">
        Group-qualification and bracket markets unlock as remaining World Cup fixtures settle.
      </div>
    </div>
  );
}
