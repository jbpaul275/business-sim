import { mulRate, type Money } from '@bizsim/money';
import {
  DEFAULT_MAINTENANCE_PCT,
  LEAD_TIMES,
  maxSeatsFor,
  type Action,
  type Business,
  type EngineEvent,
  type PeriodIndex,
  type ScheduledAction,
  type WorldState,
} from '@bizsim/schemas';
import { setStreamPrice } from './archetypes.js';
import { netBookValue } from './depreciation.js';
import { DEBT_PRODUCTS, underwrite } from './debt.js';
import type { ActionFlows } from './period.js';

/**
 * Action application — spec §9.3, with the lead times and cost/effect
 * asymmetry of §9.3.1.
 *
 * Two rules run through everything here:
 *   - Blocks do not auto-scale. The engine reports the gap; adding a block is a
 *     player action with a lead time. Auto-hiring removes the decision and the
 *     tension. (The exception is DELEGATED businesses, handled in the tick.)
 *   - Cost begins when the block is added; capacity arrives after the lead time.
 */

export type FlowsByBusiness = Map<string, ActionFlows>;

const findBusinessByStream = (state: WorldState, streamId: string): Business | undefined =>
  state.businesses.find((b) => b.streams.some((s) => s.id === streamId));

const findBusinessByCost = (state: WorldState, costId: string): Business | undefined =>
  state.businesses.find((b) => b.costs.stepFixed.some((c) => c.id === costId));

const findBusinessByDebt = (state: WorldState, debtId: string): Business | undefined =>
  state.businesses.find((b) => b.debts.some((d) => d.id === debtId));

const findBusinessByAsset = (state: WorldState, assetId: string): Business | undefined =>
  state.businesses.find((b) => b.assets.some((a) => a.id === assetId));

const reject = (period: PeriodIndex, action: Action, reason: string): EngineEvent => ({
  period,
  kind: 'ACTION_REJECTED',
  severity: 'WARNING',
  detail: { action: action.kind, reason },
});

/** Actions whose full implementation lands in M7 (multi-business, §9.5–9.6). */
const DEFERRED_TO_M7 = new Set<Action['kind']>(['START_BUSINESS', 'SELL_BUSINESS']);

export interface ApplyContext {
  state: WorldState;
  flows: FlowsByBusiness;
  nextId: () => string;
}

function flowsFor(ctx: ApplyContext, businessId: string): ActionFlows {
  const existing = ctx.flows.get(businessId);
  if (existing) return existing;
  throw new Error(`No flow accumulator for business ${businessId}`);
}

/**
 * Apply an action's immediate effects. Returns events for anything rejected.
 * `matured` distinguishes the delayed half of a scheduled action from the
 * immediate half submitted this quarter.
 */
export function applyAction(
  ctx: ApplyContext,
  action: Action,
  phase: 'IMMEDIATE' | 'MATURED',
): EngineEvent[] {
  const { state } = ctx;
  const period = state.currentPeriod;
  const events: EngineEvent[] = [];

  if (DEFERRED_TO_M7.has(action.kind)) {
    return [reject(period, action, 'Not implemented until M7 (multi-business).')];
  }

  switch (action.kind) {
    case 'SET_PRICE': {
      const business = findBusinessByStream(state, action.streamId);
      const stream = business?.streams.find((s) => s.id === action.streamId);
      if (!stream) return [reject(period, action, `Unknown stream ${action.streamId}`)];
      setStreamPrice(stream, action.newPrice);
      return events;
    }

    case 'SET_MARKETING_SPEND': {
      const business = findBusinessByStream(state, action.streamId);
      const stream = business?.streams.find((s) => s.id === action.streamId);
      if (!stream) return [reject(period, action, `Unknown stream ${action.streamId}`)];
      stream.marketingSpendPerQuarter = action.amountPerQuarter;
      return events;
    }

    case 'ADD_STEP_BLOCK': {
      const business = findBusinessByCost(state, action.costId);
      const cost = business?.costs.stepFixed.find((c) => c.id === action.costId);
      if (!business || !cost) return [reject(period, action, `Unknown cost line ${action.costId}`)];
      if (phase === 'IMMEDIATE') {
        // Cost lands now. Capacity lands when the scheduled half matures.
        cost.pendingBlocks += action.blocks;
      } else {
        const moving = Math.min(cost.pendingBlocks, action.blocks);
        cost.pendingBlocks -= moving;
        cost.currentBlocks += moving;
        events.push({
          period,
          businessId: business.id,
          kind: 'STEP_BLOCK_CROSSED',
          severity: 'INFO',
          detail: { line: cost.label, blocks: cost.currentBlocks },
        });
      }
      return events;
    }

    case 'REMOVE_STEP_BLOCK': {
      const business = findBusinessByCost(state, action.costId);
      const cost = business?.costs.stepFixed.find((c) => c.id === action.costId);
      if (!business || !cost) return [reject(period, action, `Unknown cost line ${action.costId}`)];
      const removable = Math.max(0, cost.currentBlocks - cost.minimumBlocks);
      const removing = Math.min(removable, action.blocks);
      if (removing === 0) {
        return [reject(period, action, `${cost.label} is already at its minimum block count.`)];
      }
      cost.currentBlocks -= removing;
      flowsFor(ctx, business.id).severance += mulRate(cost.removeSeverancePerBlock, removing);
      return events;
    }

    case 'PURCHASE_ASSET': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      const flows = flowsFor(ctx, business.id);
      const spec = action.asset;
      const totalCost = mulRate(spec.grossCost, spec.quantity);

      for (let i = 0; i < spec.quantity; i++) {
        business.assets.push({
          id: ctx.nextId(),
          label: spec.label,
          category: spec.category,
          grossCost: spec.grossCost,
          acquiredPeriod: period,
          usefulLifeYears: spec.usefulLifeYears,
          accumulatedDepreciation: 0n,
          salvageValue: 0n,
          maintenancePctOfGrossPerYear: DEFAULT_MAINTENANCE_PCT[spec.category],
          section179Elected: spec.section179Elected,
        });
      }

      flows.capex += totalCost;
      if (spec.section179Elected) flows.section179Deductions += totalCost;

      if (action.financing === 'DEBT' && action.debtSpec) {
        const decision = underwrite(business, action.debtSpec, state.config, state.household, period);
        if (!decision.approved) {
          events.push({
            period,
            businessId: business.id,
            kind: 'UNDERWRITING_DECLINED',
            severity: 'WARNING',
            detail: { reason: decision.reason },
          });
        } else {
          const fee = mulRate(
            action.debtSpec.requestedPrincipal,
            DEBT_PRODUCTS[action.debtSpec.kind].originationFeePct,
          );
          business.debts.push({
            id: ctx.nextId(),
            label: `${action.debtSpec.kind} — ${spec.label}`,
            kind: action.debtSpec.kind,
            originalPrincipal: action.debtSpec.requestedPrincipal,
            outstandingPrincipal: action.debtSpec.requestedPrincipal,
            annualRate: decision.rate,
            termQuarters: action.debtSpec.termQuarters,
            originatedPeriod: period,
            originationFeePct: DEBT_PRODUCTS[action.debtSpec.kind].originationFeePct,
            personalGuarantee: decision.requiresPersonalGuarantee,
            covenants: [],
          });
          flows.debtDrawdowns += action.debtSpec.requestedPrincipal;
          flows.debtOriginationFees += fee;
        }
      }
      return events;
    }

    case 'DISPOSE_ASSET': {
      const business = findBusinessByAsset(state, action.assetId);
      const asset = business?.assets.find((a) => a.id === action.assetId);
      if (!business || !asset) return [reject(period, action, `Unknown asset ${action.assetId}`)];
      const flows = flowsFor(ctx, business.id);
      flows.disposalProceeds += action.salePrice;
      flows.disposalsAtCost += asset.grossCost;
      flows.accumDepOnDisposals += asset.accumulatedDepreciation;
      flows.gainOnDisposal += action.salePrice - netBookValue(asset);
      business.assets = business.assets.filter((a) => a.id !== action.assetId);
      return events;
    }

    case 'RAISE_DEBT': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      const flows = flowsFor(ctx, business.id);
      const product = DEBT_PRODUCTS[action.spec.kind];

      if (phase === 'IMMEDIATE') {
        // Underwritten at submission — that is when a lender underwrites — and
        // the fee lands now while proceeds arrive next quarter (§9.3.1).
        const decision = underwrite(business, action.spec, state.config, state.household, period);
        if (!decision.approved) {
          return [
            {
              period,
              businessId: business.id,
              kind: 'UNDERWRITING_DECLINED',
              severity: 'WARNING',
              detail: { reason: decision.reason, dscr: decision.dscr ?? 'n/a' },
            },
          ];
        }
        flows.debtOriginationFees += mulRate(action.spec.requestedPrincipal, product.originationFeePct);
        return events;
      }

      const decision = underwrite(business, action.spec, state.config, state.household, period);
      business.debts.push({
        id: ctx.nextId(),
        label: `${action.spec.kind} facility`,
        kind: action.spec.kind,
        originalPrincipal: action.spec.requestedPrincipal,
        outstandingPrincipal:
          action.spec.kind === 'REVOLVER' ? 0n : action.spec.requestedPrincipal,
        annualRate: decision.rate,
        termQuarters: action.spec.termQuarters,
        originatedPeriod: period,
        originationFeePct: product.originationFeePct,
        personalGuarantee: decision.requiresPersonalGuarantee,
        ...(action.spec.kind === 'REVOLVER'
          ? { revolverLimit: action.spec.requestedPrincipal }
          : {}),
        covenants: [],
      });
      if (action.spec.kind !== 'REVOLVER') {
        flows.debtDrawdowns += action.spec.requestedPrincipal;
      }
      return events;
    }

    case 'REPAY_DEBT': {
      const business = findBusinessByDebt(state, action.debtId);
      const debt = business?.debts.find((d) => d.id === action.debtId);
      if (!business || !debt) return [reject(period, action, `Unknown debt ${action.debtId}`)];
      const amount = action.amount < debt.outstandingPrincipal ? action.amount : debt.outstandingPrincipal;
      debt.outstandingPrincipal -= amount;
      flowsFor(ctx, business.id).principalRepayments += amount;
      return events;
    }

    case 'DRAW_REVOLVER': {
      const business = findBusinessByDebt(state, action.debtId);
      const debt = business?.debts.find((d) => d.id === action.debtId);
      if (!business || !debt) return [reject(period, action, `Unknown debt ${action.debtId}`)];
      if (debt.kind !== 'REVOLVER') return [reject(period, action, `${debt.label} is not a revolver.`)];
      const available = (debt.revolverLimit ?? 0n) - debt.outstandingPrincipal;
      const draw = action.amount < available ? action.amount : available;
      if (draw <= 0n) return [reject(period, action, 'Revolver has no available capacity.')];
      debt.outstandingPrincipal += draw;
      flowsFor(ctx, business.id).debtDrawdowns += draw;
      return events;
    }

    case 'INJECT_CAPITAL': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      if (state.household.cash < action.amount) {
        return [reject(period, action, 'Household does not have that much cash.')];
      }
      state.household.cash -= action.amount;
      state.household.cumulativeInjections += action.amount;
      flowsFor(ctx, business.id).ownerContributions += action.amount;
      return events;
    }

    case 'DISTRIBUTE': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      flowsFor(ctx, business.id).ownerDistributions += action.amount;
      state.household.cash += action.amount;
      state.household.cumulativeDraws += action.amount;
      return events;
    }

    case 'EXPAND_CAPACITY': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      const stream = business?.streams.find((s) => s.id === action.spec.streamId);
      if (!business || !stream) return [reject(period, action, 'Unknown business or stream.')];
      // Buildout cost is spread over two quarters and capitalised as leasehold
      // improvements — it has to land on PP&E, not vanish into cash, or gross
      // PP&E stops reconciling to capex.
      const half = mulRate(action.spec.buildoutCost, 0.5);
      const capitalise = (): void => {
        flowsFor(ctx, business.id).capex += half;
        business.assets.push({
          id: ctx.nextId(),
          label: `Buildout — ${stream.label}`,
          category: 'LEASEHOLD_IMPROVEMENTS',
          grossCost: half,
          acquiredPeriod: period,
          usefulLifeYears: 15,
          accumulatedDepreciation: 0n,
          salvageValue: 0n,
          maintenancePctOfGrossPerYear: DEFAULT_MAINTENANCE_PCT.LEASEHOLD_IMPROVEMENTS,
          section179Elected: false,
        });
      };

      if (phase === 'IMMEDIATE') {
        capitalise();
        return events;
      }
      capitalise();
      const params = stream.params;
      if (params.kind === 'TRAFFIC' && action.spec.deltaSeats && params.capacityModel.kind === 'SEAT_TURNS') {
        // Validation bounds seats at concept lock; without the same bound here
        // a player just buys their way past it one buildout at a time. Taking
        // more space is allowed — it is the free seats that are not.
        const capacity = params.capacityModel;
        capacity.floorAreaSqFt += action.spec.deltaFloorAreaSqFt ?? 0;
        capacity.seats = Math.min(
          capacity.seats + action.spec.deltaSeats,
          maxSeatsFor(capacity.floorAreaSqFt),
        );
      } else if (params.kind === 'OCCUPANCY' && action.spec.deltaUnits) {
        params.units += action.spec.deltaUnits;
      } else if (params.kind === 'PROJECT_BACKLOG' && action.spec.deltaExecutionCapacity) {
        params.executionCapacityPerQuarter += action.spec.deltaExecutionCapacity;
      }
      return events;
    }

    case 'DELEGATE': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      if (phase === 'IMMEDIATE') return events;
      business.status = 'DELEGATED';
      business.delegation = {
        managerCompPerQuarter: action.managerCompPerQuarter,
        managerQuality: action.managerQuality,
        delegatedAtPeriod: period,
        cumulativeDriftPct: 0,
      };
      business.costs.fixedPeriod.push({
        id: ctx.nextId(),
        label: 'General manager',
        class: 'FIXED_PERIOD',
        amountPerQuarter: action.managerCompPerQuarter,
        annualEscalatorPct: state.config.annualInflationPct,
        startPeriod: period,
        renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
        statementLine: 'LABOR',
        accruable: false,
        isLabor: true,
        isOwnerComp: false,
        isPrepaidExpense: false,
      });
      return events;
    }

    case 'RECLAIM': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business || !business.delegation) {
        return [reject(period, action, 'Business is not delegated.')];
      }
      if (phase === 'IMMEDIATE') return events;
      business.status = 'OPERATING';
      business.delegation.reclaimedAtPeriod = period;
      business.costs.fixedPeriod = business.costs.fixedPeriod.filter(
        (c) => c.label !== 'General manager',
      );
      return events;
    }

    case 'CHANGE_ENTITY_FORM': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      if (phase === 'IMMEDIATE') return events;
      if (action.newForm === 'S_CORP') {
        const hasOwnerComp = business.costs.fixedPeriod.some(
          (c) => c.isOwnerComp && c.amountPerQuarter > 0n,
        );
        if (!hasOwnerComp) {
          return [
            reject(period, action, 'S-corp election requires reasonable owner W-2 compensation.'),
          ];
        }
      }
      business.legalForm = action.newForm;
      return events;
    }

    case 'CLOSE_BUSINESS': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      if (phase === 'IMMEDIATE') {
        const severance = business.costs.stepFixed.reduce<Money>(
          (acc, c) => acc + mulRate(c.removeSeverancePerBlock, c.currentBlocks),
          0n,
        );
        flowsFor(ctx, business.id).severance += severance;
        return events;
      }
      business.status = 'CLOSED';
      business.streams = [];
      return events;
    }

    case 'SET_CRISIS_POLICY':
      state.config.crisisPolicy = [...action.policy];
      return events;

    case 'ADJUST_ASSUMPTION': {
      for (const business of state.businesses) {
        const assumption = business.assumptions.byId[action.assumptionId];
        if (assumption) {
          assumption.value = action.newValue;
          assumption.provenance = action.evidence ? 'PLAYER_SOURCED' : 'PLAYER_ASSUMED';
          return events;
        }
      }
      return [reject(period, action, `Unknown assumption ${action.assumptionId}`)];
    }

    default:
      return [reject(period, action, 'Unrecognised action.')];
  }
}

/** Enqueue the delayed half of an action, if it has one. */
export function schedule(
  action: Action,
  submittedPeriod: PeriodIndex,
): ScheduledAction | undefined {
  const lead = LEAD_TIMES[action.kind];
  if (lead.effect === 0) return undefined;
  return {
    action,
    submittedPeriod,
    effectivePeriod: submittedPeriod + lead.effect,
    costAppliedPeriod: submittedPeriod + lead.cost,
    costApplied: lead.cost === 0,
  };
}
