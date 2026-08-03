import type { Business, BusinessModel, Money } from '@bizsim/schemas';

/**
 * Writing an adjudicated number back into the model it came from.
 *
 * `ADJUST_ASSUMPTION` set the value on the register and stopped there. The
 * register is not what the tick reads — formulas read the model, through
 * `ctx.p(path, value)`, and that second argument is the parameter itself. So a
 * player who argued a $60k freezer down to $22k, and won, changed a line in a
 * document and nothing in their business.
 *
 * That made the entire challenge contract theatre, which is worse than not
 * having it: §11.3 exists so a model someone takes to a lender reflects the
 * argument that produced it.
 *
 * Paths are minted by `buildModel` in two shapes and this resolves both:
 *
 *     streams.s1.params.avgTicket        → the stream with id "s1"
 *     costs.food_cost.pctOfRevenue       → the cost line with id "food_cost"
 *     costs.payrollLoadPct               → a scalar on the cost structure
 *
 * The array segments are keyed by id rather than index, because a register
 * written against positions would silently point at the wrong line the first
 * time a cost was reordered.
 */

/**
 * A model or a live business — the shapes the paths walk are the same.
 *
 * Setup argues with a `BusinessModel` before the world exists; the tick argues
 * with a `Business` after it does. The streams and cost lines are structurally
 * identical in both, and requiring one would mean the same path resolver twice.
 */
interface Target {
  streams: (Business | BusinessModel)['streams'];
  costs: Business['costs'];
  workingCapital?: BusinessModel['workingCapital'];
  /** Pre-commit: the model's capex specs, one entry per line. */
  capex?: BusinessModel['capex'];
  /** Post-commit: the opened assets, one entry per unit, sharing a label. */
  assets?: Business['assets'];
}

/** Every cost line, whatever bucket it lives in. */
const costLines = (costs: Business['costs']): { id: string; [k: string]: unknown }[] => [
  ...costs.variableWithRevenue,
  ...costs.variableWithActivity,
  ...costs.stepFixed,
  ...costs.fixedPeriod,
];

/**
 * Set the value a path points at, and report whether anything was found.
 *
 * Returns false rather than throwing: a register entry whose path no longer
 * resolves is a bug worth surfacing, and a crash in the middle of an argument
 * about a freezer is not how to surface it.
 */
export function setAtPath(target: Target, path: string, value: number | Money): boolean {
  const segments = path.split('.');
  const [root, ...rest] = segments;
  if (rest.length === 0) return false;

  if (root === 'streams') {
    const [streamId, ...tail] = rest;
    const stream = target.streams.find((s) => s.id === streamId);
    return stream ? assign(stream as unknown as Record<string, unknown>, tail, value) : false;
  }

  if (root === 'costs') {
    // `costs.payrollLoadPct` — a scalar on the structure itself.
    if (rest.length === 1) {
      return assign(target.costs as unknown as Record<string, unknown>, rest, value);
    }
    const [costId, ...tail] = rest;
    const line = costLines(target.costs).find((c) => c.id === costId);
    // `capacityPerBlock` lives under a `capacity` object on the line, and the
    // register flattens it, so the one nested case is resolved explicitly.
    if (line && tail.length === 1 && tail[0] === 'capacityPerBlock') {
      const capacity = (line as { capacity?: Record<string, unknown> }).capacity;
      if (!capacity) return false;
      capacity['capacityPerBlock'] = value;
      return true;
    }
    return line ? assign(line as Record<string, unknown>, tail, value) : false;
  }

  if (root === 'workingCapital' && target.workingCapital) {
    return assign(target.workingCapital as unknown as Record<string, unknown>, rest, value);
  }

  /**
   * Capex, the root this resolver silently lacked.
   *
   * The register has always minted `capex.<label>.grossCost` assumptions, so a
   * player could challenge a $3.26M phantom renovation, win the ruling — and
   * be told the path "no longer resolves" while the model kept the number.
   * With the challenge list now ranked by dollar impact, capex sits at the
   * top, which made this the first challenge most players would ever try.
   *
   * Labels may contain dots, so the field is the last segment and the label is
   * everything between. Pre-commit the target carries `capex` specs; a live
   * business carries `assets`, quantity-expanded with the label shared — every
   * matching unit moves, because they are one line wearing many rows.
   */
  if (root === 'capex') {
    const field = rest[rest.length - 1];
    const label = rest.slice(0, -1).join('.');
    if (field === undefined || label === '') return false;
    let hit = false;
    for (const item of target.capex ?? []) {
      if (item.label === label && assign(item as unknown as Record<string, unknown>, [field], value)) {
        hit = true;
      }
    }
    for (const asset of target.assets ?? []) {
      if (asset.label === label && assign(asset as unknown as Record<string, unknown>, [field], value)) {
        hit = true;
      }
    }
    return hit;
  }

  return false;
}

function assign(
  object: Record<string, unknown>,
  segments: readonly (string | undefined)[],
  value: number | Money,
): boolean {
  let cursor: Record<string, unknown> = object;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (key === undefined) return false;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) return false;
    cursor = next as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (last === undefined || !(last in cursor)) return false;

  // Money is bigint and everything else is a number. Writing the wrong one
  // produces a `Cannot mix BigInt` throw several steps later, in a formula that
  // has nothing to do with the assumption that caused it.
  const existing = cursor[last];
  if (typeof existing === 'bigint' && typeof value === 'number') return false;
  if (typeof existing === 'number' && typeof value === 'bigint') return false;

  cursor[last] = value;
  return true;
}
