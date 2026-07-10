import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

/**
 * Implied-price sparkline from REAL pool history (recorded server-side each
 * time on-chain pool balances change). Renders a flat baseline until a market
 * has at least two real data points — never fabricated.
 */
export default function Sparkline({ marketId }: { marketId: string }) {
  const { data: points = [] } = useQuery({
    queryKey: ['history', marketId],
    queryFn: () => api.history(marketId),
    refetchInterval: 30_000,
  });

  const w = 220;
  const h = 44;
  if (points.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="#d8e2f5" strokeWidth="2" strokeDasharray="3 5" />
      </svg>
    );
  }

  const t0 = points[0]!.ts;
  const t1 = points[points.length - 1]!.ts || t0 + 1;
  const xs = points.map((p) => ((p.ts - t0) / Math.max(1, t1 - t0)) * (w - 4) + 2);
  const ys = points.map((p) => h - 6 - (p.impliedYesBps / 10_000) * (h - 12));
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ');

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="#2f6bff" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
