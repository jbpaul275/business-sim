import type { Money } from './primitives.js';
import type { Assumption } from './assumptions.js';

/**
 * Per-quarter delta attribution — spec §10.4.
 *
 * "Every derived figure shown to the player must be traceable to its driving
 * assumptions. Concretely: when the UI reports a change, it annotates with the
 * driver and its tag." The MVP has no stochastic noise, so a deterministic
 * output reads as a fact about the world rather than an echo of an input the
 * player chose — this record is the mitigation.
 *
 * Computed by the engine, never by a model. §11.5's `attributions` field and
 * M8's provenance-annotated deltas both read this structure; the narration may
 * describe a driver in prose, but the driver itself is arithmetic.
 */

export interface AttributionDriver {
  /** Human name for the mechanism: "Seasonality", "Price", "Kitchen line". */
  label: string;
  /** One engine-authored sentence a player can check: "calendar Q3→Q4 (1.08→0.98)". */
  explanation: string;
  /**
   * Signed dollar contribution to the line's delta. Driver amounts are
   * normalised to sum to the line's actual delta, so shares are honest even
   * where a component is estimated from a log-decomposition.
   */
  amount: Money;
  /** The registered assumption behind the move, when one exists. */
  assumptionId?: string;
  /** Model path of that assumption — resolvable via the register's byPath. */
  path?: string;
  /** Provenance tag of that assumption — the §10.4 annotation. */
  provenance?: Assumption['provenance'];
}

/** Statement lines the attribution covers. EBITDA is derived from these. */
export type AttributedLine =
  | 'revenue'
  | 'costOfGoodsSold'
  | 'labor'
  | 'occupancy'
  | 'marketing'
  | 'generalAndAdmin';

export interface DeltaAttribution {
  line: AttributedLine;
  /** Display name: "Revenue", "COGS", "Labor"… */
  lineLabel: string;
  previous: Money;
  current: Money;
  /** current − previous. */
  delta: Money;
  /** Sorted by |amount| descending. Sums to `delta` (any residual is its own driver). */
  drivers: AttributionDriver[];
}
