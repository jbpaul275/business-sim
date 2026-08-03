import { toCompact } from '@bizsim/money';
import type { EngineEvent } from '@bizsim/schemas';

/**
 * Engine events, in English.
 *
 * They were printed as their own field dump:
 *
 *   ▸ CASH_CRISIS  shortfall=16462.92 iteration=1
 *   ▸ CRISIS_REMEDY_APPLIED  remedy=DEFER_OWNER_COMP note=Deferred $8,561.25
 *
 * which is, as the player put it, "largely the AI talking to itself". Those
 * lines are the most consequential thing on the screen — they are the moments
 * the business nearly died and what was done about it — and they were the
 * least readable. `iteration=1` in particular means nothing to anyone outside
 * this codebase, and `remedy=SALE_LEASEBACK` is a sentence that has been
 * compressed into a constant.
 *
 * Every event carries a `detail` bag, so the prose is written per kind and
 * reads the fields it needs. An unrecognised kind falls back to the dump
 * rather than swallowing an event nobody has written a sentence for yet: a
 * missing event is worse than an ugly one.
 */

const money = (v: number | string | undefined): string =>
  v === undefined ? '' : toCompact(BigInt(Math.round(Number(v) * 100)));

/**
 * What a remedy costs beyond the cash it raised.
 *
 * The engine's own note is already a sentence — "Deferred $21,215.62 of owner
 * compensation", "Factored $712,884.87 of receivables at a 4% discount" — so
 * repeating it in other words was noise. What the note does not say is which
 * of these are reversible. Drawing a revolver is a Tuesday; selling the
 * building you operate out of is not, and both read identically before this.
 */
const REMEDY_CONSEQUENCE: Record<string, string> = {
  EMERGENCY_DEBT: 'That is personally guaranteed — it follows you out of the business.',
  SALE_LEASEBACK: 'That asset is gone for good, and its rent is now a permanent cost.',
  FACTOR_AR: 'Cash today at a discount, and next quarter collects less.',
  DEFER_OWNER_COMP: 'Owed, not cancelled — it accrues.',
};

export function describeEvent(e: EngineEvent): string {
  const d = e.detail;
  switch (e.kind) {
    case 'CASH_CRISIS':
      return `Ran out of cash — ${money(d['shortfall'])} short of what this quarter needed.`;

    case 'CRISIS_REMEDY_APPLIED': {
      const remedy = String(d['remedy']);
      const note = d['note'] ? String(d['note']) : remedy;
      const consequence = REMEDY_CONSEQUENCE[remedy];
      return consequence ? `${note} ${consequence}` : note;
    }

    case 'RUNWAY_WARNING': {
      const q = Number(d['quarters']);
      return q < 0.25
        ? 'Less than a month of cash left at this burn rate.'
        : `About ${q.toFixed(1)} quarters of cash left at this burn rate.`;
    }

    case 'INSOLVENCY':
      return (
        `Insolvent. Everything was sold for ${money(d['liquidationProceeds'])}, ` +
        `and ${money(d['guaranteedDeficiency'])} of guaranteed debt follows you personally.`
      );

    case 'PERSONAL_INSOLVENCY':
      return 'Your household is insolvent too — the guarantees came due and there was nothing behind them.';

    case 'CAPACITY_CONSTRAINED':
      return d['blocksNeeded'] !== undefined
        ? `${String(d['line'])} is the bottleneck — it would take ${d['blocksNeeded']} blocks to serve everyone who wanted in.`
        : `${String(d['line'])} capped what you could serve this quarter.`;

    case 'LOST_DEMAND_THRESHOLD':
      return `Turned away enough customers to matter — ${d['lostDemand'] ?? 'demand'} went unserved.`;

    case 'STEP_BLOCK_CROSSED':
      return `${String(d['line'])} crossed a step: ${d['from'] ?? '?'} blocks to ${d['to'] ?? '?'}, and the cost lands now.`;

    case 'COVENANT_BREACH':
      return `Loan covenant breached — ${String(d['covenant'] ?? 'a condition of the debt')} is out of compliance.`;

    case 'UNDERWRITING_DECLINED':
      return `The lender said no: ${String(d['reason'] ?? 'it did not underwrite')}.`;

    case 'ACTION_REJECTED':
      return `That did not happen — ${String(d['reason'] ?? 'the action was rejected')}.`;

    case 'ELASTICITY_CLAMP':
      return 'The price move was large enough that the demand response was capped rather than extrapolated.';

    case 'BENCH_STRESS':
      return 'People are sitting idle — you are paying for hours nobody is billing.';

    case 'ASSUMPTION_OUT_OF_BAND':
      return `${String(d['label'] ?? 'An assumption')} is outside its benchmark range.`;

    case 'MILESTONE_REACHED':
      return 'Milestone reached.';

    default: {
      // Deliberately not silent. An event with no sentence yet is still an
      // event, and hiding it would be a worse failure than showing the fields.
      const fields = Object.entries(d)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `${e.kind}${fields ? `  ${fields}` : ''}`;
    }
  }
}
