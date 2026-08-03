import { ratio, toCompact, type Money } from '@bizsim/money';
import { streamPrice, type TickResult } from '@bizsim/engine';
import type { Business, WorldState } from '@bizsim/schemas';
import type { Briefing } from '@bizsim/llm';
import { priceUnits } from './pricing.js';

/**
 * Everything the model is allowed to know, and nothing else.
 *
 * This is the whole safety mechanism, and it is a data structure rather than an
 * instruction. The model cannot quote a figure the engine did not compute
 * because it is never shown one: no state object, no statement, no access to
 * anything but the lines below. §1.1 forbids the LLM computing a value that
 * appears on a statement, and the reliable way to enforce that is to make sure
 * it never has the inputs.
 *
 * `figures` carries the same money a second time, unformatted, so the guard can
 * check the reply against exactly what the prompt contained. Building both from
 * one pass is deliberate — two lists that could drift would produce a checker
 * that rejects the truth.
 */

interface Line {
  label: string;
  value: string;
  /** True when `value` is money the model may quote back. */
  money?: boolean;
}

/**
 * §11.5's input is *current and prior* statements plus the quarter's events —
 * narration is about change, and a briefing with one quarter in it can only
 * describe a level. Optional because the advisor's Q&A path predates it and a
 * question mid-decision is about the present.
 */
export interface BriefingContext {
  prior?: { revenue: Money; ebitda: Money; cash: Money };
  /** This quarter's engine events, already described in words. */
  events?: readonly string[];
}

export function buildBriefing(
  world: WorldState,
  business: Business,
  result: TickResult,
  findings: readonly string[],
  commands: readonly string[],
  context: BriefingContext = {},
): Briefing {
  const entry = result.statements.byBusiness[business.id];
  const lines: Line[] = [];
  const add = (label: string, value: string, money = false): void => {
    lines.push({ label, value, ...(money ? { money: true } : {}) });
  };

  add('Business', business.name);
  add('Quarter', `period ${result.statements.period} of ${world.config.milestonePeriod}`);
  add('Status', business.status);

  if (entry) {
    const is = entry.incomeStatement;
    const m = entry.derivedMetrics;
    add('Revenue this quarter', toCompact(is.revenue), true);
    add('EBITDA', `${toCompact(is.ebitda)} (${pct(ratio(is.ebitda, is.revenue))} margin)`, true);
    add('Net income', toCompact(is.netIncome), true);
    add('Cash in the business', toCompact(entry.balanceSheet.cash), true);
    add('Equity', toCompact(entry.balanceSheet.totalEquity), true);
    add(
      'Runway',
      Number.isFinite(m.cashRunwayQuarters) ? `${m.cashRunwayQuarters.toFixed(1)} quarters` : 'indefinite',
    );
    add('Break-even revenue', toCompact(m.breakEvenRevenue), true);
    if (m.breakEvenVolume) {
      add('Break-even volume', `${m.breakEvenVolume.value.toFixed(1)} ${m.breakEvenVolume.unit}`);
    }
    add('Peak cash need so far', toCompact(m.peakCashNeed), true);

    const stream = m.streamMetrics[0];
    if (stream) {
      add('Archetype', stream.archetype);
      add('Volume served', `${Math.round(stream.realizedVolume).toLocaleString()}`);
      if (stream.capacityVolume !== undefined) {
        add(
          'Capacity',
          `${Math.round(stream.capacityVolume).toLocaleString()} (${pct(
            stream.realizedVolume / stream.capacityVolume,
          )} used)`,
        );
      }
      if (stream.occupancy !== undefined) add('Occupancy', pct(stream.occupancy));
      if (stream.realizedUtilization !== undefined) {
        add('Utilisation', pct(stream.realizedUtilization));
      }
      if (stream.lostDemand > 0.5) {
        add('Demand turned away', Math.round(stream.lostDemand).toLocaleString());
      }
    }
  }

  const first = business.streams[0];
  if (first) {
    const units = priceUnits(first, streamPrice(first));
    add(
      'Price',
      `$${units.command.toLocaleString()} ${units.per}` +
        (units.colloquial ? ` (${units.colloquial})` : ''),
      true,
    );
    add('Marketing spend', `${toCompact(first.marketingSpendPerQuarter)} a quarter`, true);
    add('Price elasticity', first.modifiers.priceElasticity.toFixed(2));
  }

  // Cost lines, because "cut costs" is meaningless without knowing which ones
  // exist and which a single quarter can reach.
  for (const cost of business.costs.stepFixed) {
    add(
      `Staffing — ${cost.label} (id ${cost.id})`,
      `${cost.currentBlocks} blocks at ${toCompact(cost.blockCostPerQuarter)} each, minimum ${cost.minimumBlocks}`,
      true,
    );
  }
  /**
   * The variable rates, because they ARE the model's cost assumptions and the
   * advisor was guessing at them. Live: a vending operator said his margins on
   * coffee and soft-serve should run 60-70%, and the advisor answered that his
   * "50-70% margins are already baked into the model" — while the model
   * carried a flat 50% product cost it had never been shown. A model that
   * cannot see an assumption cannot be honest about it; one that can is
   * expected to be, and the `assume` id makes the honest answer actionable.
   */
  for (const cost of business.costs.variableWithRevenue) {
    const assumptionId = business.assumptions.byPath[`costs.${cost.id}.pctOfRevenue`];
    add(
      `Cost rate — ${cost.label}`,
      `${pct(cost.pctOfRevenue)} of revenue, a model assumption` +
        (assumptionId ? ` — \`assume ${assumptionId} <pct>\` revises it` : ''),
    );
  }
  for (const cost of business.costs.variableWithActivity) {
    const assumptionId = business.assumptions.byPath[`costs.${cost.id}.costPerUnit`];
    add(
      `Cost per unit — ${cost.label}`,
      `${toCompact(cost.costPerUnit)} per ${cost.driver.toLowerCase().replace(/_/g, ' ')}, a model assumption` +
        (assumptionId ? ` — \`assume ${assumptionId} <amount>\` revises it` : ''),
      true,
    );
  }
  const fixed = business.costs.fixedPeriod.reduce<Money>((a, c) => a + c.amountPerQuarter, 0n);
  add('Fixed costs a quarter', toCompact(fixed), true);

  for (const debt of business.debts) {
    add(
      `Debt — ${debt.label}`,
      `${toCompact(debt.outstandingPrincipal)} outstanding at ${pct(debt.annualRate)}` +
        (debt.revolverLimit !== undefined ? ` (limit ${toCompact(debt.revolverLimit)})` : ''),
      true,
    );
  }

  add('Household cash', toCompact(world.household.cash), true);

  // Last quarter, so "what changed" is a comparison the model was handed rather
  // than a memory it invents. Money-flagged: the endpoints of a delta are
  // figures it may quote.
  if (context.prior) {
    add('Last quarter revenue', toCompact(context.prior.revenue), true);
    add('Last quarter EBITDA', toCompact(context.prior.ebitda), true);
    add('Last quarter closing cash', toCompact(context.prior.cash), true);
  }
  // The quarter's events are the only legal sources for a causal claim (§11.5:
  // no invented mechanisms). Described in words because the model narrates in
  // words; the money inside them is money the engine printed.
  for (const [i, event] of (context.events ?? []).entries()) {
    add(`Event ${i + 1} this quarter`, event, true);
  }

  const text = [
    'BRIEFING — every number below was computed by the engine. You have no others.',
    '',
    ...lines.map((l) => `${l.label}: ${l.value}`),
    '',
    findings.length > 0
      ? `Already on the player's screen, from the deterministic advisor — do not repeat these:\n${findings
          .map((f) => `- ${f}`)
          .join('\n')}`
      : 'The deterministic advisor found nothing specific to say this quarter.',
    '',
    // A list with meanings, not a bag of verbs. Handed only names, the model
    // guessed at semantics and told a player `quotes` listed business sites.
    // The closing sentence is load-bearing: the honest answer to an
    // unmodelled move is "not in this build", never a description of a
    // mechanic that does not exist.
    'The commands below are the ONLY levers in this build. A move that maps to none of ' +
      'them is not modelled — say so plainly rather than describing a screen or mechanic ' +
      'that does not exist.',
    ...commands.map((c) => `- ${c}`),
  ].join('\n');

  return {
    text,
    // Every money string that appeared above, in the form the model will read
    // it. `toCompact` rounds, so the guard's 2% tolerance is what makes a model
    // restating "$1.1M" for $1,148,000 legal.
    figures: lines.filter((l) => l.money).flatMap((l) => l.value.match(/\$[\d,.]+[kmb]?/gi) ?? []),
    commands,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
