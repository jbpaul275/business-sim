import { fromDisplay, type Money } from '@bizsim/money';
import type { Action, Business } from '@bizsim/schemas';
import { parseAssumptionValue } from './setup';

/**
 * The action bar's controls, translated into engine actions — the server owns
 * the translation so a client cannot construct an action shape the UI never
 * offered. Mirrors the CLI's command semantics exactly (play.ts is the
 * reference): expand maps to units or seats by archetype, a new territory is
 * more market rather than more room and only exists where demand is
 * territorial, repay targets the largest balance and never exceeds it.
 *
 * Everything here validates and skips rather than erroring: a malformed field
 * costs that move, not the turn.
 */

export interface TurnRequest {
  price?: number;
  marketingPerQuarter?: number;
  hire?: { costId: string; blocks: number }[];
  fire?: { costId: string; blocks: number }[];
  assume?: { assumptionId: string; value: string; evidence?: string }[];
  /** More capacity at the current site; two-quarter buildout. */
  expand?: { units: number; costDollars: number };
  /** A better product: uplift is a claim about willingness to pay, in percent. */
  upgrade?: { upliftPct: number; costDollars: number };
  /** A new territory: more addressable demand, not more capacity. Percent growth. */
  territory?: { pct: number; costDollars: number };
  /** Term loan (SBA 7(a) semantics: fee now, proceeds next quarter). */
  debt?: { amountDollars: number; termQuarters?: number };
  /** Draw on the revolver, if one exists. Dollars. */
  draw?: number;
  /** Pay principal down on the largest balance. Dollars. */
  repay?: number;
  /** Household cash into the business. Dollars. */
  inject?: number;
  /** Business cash out to the household. Dollars. */
  distribute?: number;
  skip?: number;
}

const money = (dollars: unknown): Money | undefined =>
  typeof dollars === 'number' && Number.isFinite(dollars) && dollars > 0
    ? fromDisplay(dollars)
    : undefined;

export function translateTurn(body: TurnRequest, business: Business | undefined): Action[] {
  const actions: Action[] = [];
  if (!business) return actions;
  const stream = business.streams[0];

  if (typeof body.price === 'number' && Number.isFinite(body.price) && body.price > 0 && stream) {
    actions.push({ kind: 'SET_PRICE', streamId: stream.id, newPrice: fromDisplay(body.price) });
  }
  if (
    typeof body.marketingPerQuarter === 'number' &&
    Number.isFinite(body.marketingPerQuarter) &&
    body.marketingPerQuarter >= 0 &&
    stream
  ) {
    actions.push({
      kind: 'SET_MARKETING_SPEND',
      streamId: stream.id,
      amountPerQuarter: fromDisplay(body.marketingPerQuarter),
    });
  }
  for (const h of body.hire ?? []) {
    if (typeof h.costId === 'string' && Number.isInteger(h.blocks) && h.blocks > 0) {
      actions.push({ kind: 'ADD_STEP_BLOCK', costId: h.costId, blocks: h.blocks });
    }
  }
  for (const f of body.fire ?? []) {
    if (typeof f.costId === 'string' && Number.isInteger(f.blocks) && f.blocks > 0) {
      actions.push({ kind: 'REMOVE_STEP_BLOCK', costId: f.costId, blocks: f.blocks });
    }
  }
  for (const a of body.assume ?? []) {
    if (typeof a.assumptionId !== 'string' || typeof a.value !== 'string') continue;
    const target = business.assumptions.byId[a.assumptionId];
    if (!target) continue;
    const newValue = parseAssumptionValue(target, a.value);
    if (newValue === undefined) continue;
    actions.push({
      kind: 'ADJUST_ASSUMPTION',
      assumptionId: a.assumptionId,
      newValue,
      ...(typeof a.evidence === 'string' && a.evidence.trim() !== ''
        ? { evidence: a.evidence.trim() }
        : {}),
    });
  }

  const expandCost = money(body.expand?.costDollars);
  if (
    body.expand &&
    expandCost &&
    Number.isFinite(body.expand.units) &&
    body.expand.units > 0 &&
    stream
  ) {
    actions.push({
      kind: 'EXPAND_CAPACITY',
      businessId: business.id,
      spec: {
        streamId: stream.id,
        buildoutCost: expandCost,
        ...(stream.params.kind === 'OCCUPANCY'
          ? { deltaUnits: body.expand.units }
          : { deltaSeats: body.expand.units }),
      },
    });
  }

  const upgradeCost = money(body.upgrade?.costDollars);
  if (
    body.upgrade &&
    upgradeCost &&
    Number.isFinite(body.upgrade.upliftPct) &&
    body.upgrade.upliftPct > 0 &&
    body.upgrade.upliftPct <= 100 &&
    stream
  ) {
    actions.push({
      kind: 'EXPAND_CAPACITY',
      businessId: business.id,
      spec: { streamId: stream.id, buildoutCost: upgradeCost, qualityUpliftPct: body.upgrade.upliftPct / 100 },
    });
  }

  const territoryCost = money(body.territory?.costDollars);
  if (
    body.territory &&
    territoryCost &&
    Number.isFinite(body.territory.pct) &&
    body.territory.pct > 0 &&
    stream
  ) {
    const p = stream.params;
    if (p.kind === 'UTILIZATION') {
      actions.push({
        kind: 'EXPAND_CAPACITY',
        businessId: business.id,
        spec: {
          streamId: stream.id,
          buildoutCost: territoryCost,
          deltaDemandHoursPerQuarter: p.demandHoursPerQuarter * (body.territory.pct / 100),
        },
      });
    } else if (p.kind === 'TRAFFIC') {
      actions.push({
        kind: 'EXPAND_CAPACITY',
        businessId: business.id,
        spec: {
          streamId: stream.id,
          buildoutCost: territoryCost,
          deltaAddressableTrafficPerQuarter:
            p.addressableTrafficPerQuarter * (body.territory.pct / 100),
        },
      });
    }
    // Other archetypes grow through different levers; the move is skipped,
    // matching the CLI's refusal with directions.
  }

  const principal = money(body.debt?.amountDollars);
  if (body.debt && principal) {
    const termQuarters =
      Number.isInteger(body.debt.termQuarters) && (body.debt.termQuarters ?? 0) > 0
        ? body.debt.termQuarters!
        : 40;
    actions.push({
      kind: 'RAISE_DEBT',
      businessId: business.id,
      spec: { kind: 'SBA_7A', requestedPrincipal: principal, termQuarters, personalGuarantee: true },
    });
  }

  const drawAmount = money(body.draw);
  if (drawAmount) {
    const revolver = business.debts.find((d) => d.kind === 'REVOLVER');
    if (revolver) actions.push({ kind: 'DRAW_REVOLVER', debtId: revolver.id, amount: drawAmount });
  }

  const repayAmount = money(body.repay);
  if (repayAmount) {
    const outstanding = business.debts
      .filter((d) => d.outstandingPrincipal > 0n)
      .sort((a, b) => (b.outstandingPrincipal > a.outstandingPrincipal ? 1 : -1));
    const target = outstanding[0];
    if (target) {
      actions.push({
        kind: 'REPAY_DEBT',
        debtId: target.id,
        amount: repayAmount > target.outstandingPrincipal ? target.outstandingPrincipal : repayAmount,
      });
    }
  }

  const injectAmount = money(body.inject);
  if (injectAmount) {
    actions.push({ kind: 'INJECT_CAPITAL', businessId: business.id, amount: injectAmount });
  }
  const distributeAmount = money(body.distribute);
  if (distributeAmount) {
    actions.push({ kind: 'DISTRIBUTE', businessId: business.id, amount: distributeAmount });
  }

  return actions;
}
