'use client';

import { formatAge, formatRupees } from '@/lib/money';
import type { Counts } from '@/lib/types';

/**
 * Matched / pending / needs review, with amounts rather than bare counts.
 * A session needs a clear sense of "done", and "9 items" does not give one the
 * way "₹2,10,000 outstanding" does.
 */
export function CountsHeader({ counts }: { counts: Counts | null }) {
  if (!counts) return null;
  return (
    <div className="counts">
      <div className="stat">
        <span className="k">Needs review</span>
        <span className="v">{counts.review_count + counts.unapplied_count}</span>
      </div>
      <div className="stat">
        <span className="k">
          Outstanding{counts.oldest_age_days ? ` · oldest ${formatAge(counts.oldest_age_days)}` : ''}
        </span>
        <span className="v">{formatRupees(counts.pending_minor)}</span>
      </div>
      <div className="stat">
        <span className="k">Settled ({counts.matched_count})</span>
        <span className="v">{formatRupees(counts.matched_minor)}</span>
      </div>
    </div>
  );
}
