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
import { getSecurity } from '@bizsim/seeds';
import { setStreamPrice } from './archetypes.js';
import { cloneBusiness, cloneOutlay, saleValue } from './clone.js';
import { priceAt } from './market.js';
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

/**
 * What a business changes hands for when the player names no number.
 *
 * Four times trailing EBITDA is the low end of what small operating businesses
 * actually trade at, and low is the right default: a player who has not thought
 * about the multiple should not be handed the optimistic one.
 */
const DEFAULT_SALE_MULTIPLE = 4;

const money = (amount: Money): string => `$${(Number(amount) / 100).toLocaleString()}`;

const reject = (period: PeriodIndex, action: Action, reason: string): EngineEvent => ({
  period,
  kind: 'ACTION_REJECTED',
  severity: 'WARNING',
  detail: { action: action.kind, reason },
});

/**
 * A full second interview is the setup flow's job, not the tick's.
 *
 * CLONE lands here because it needs no conversation — §9.5's whole claim is
 * that a second site takes two minutes. FULL_INTERVIEW re-enters Phase 1 and
 * cannot happen inside a pure function, so it is refused with a sentence that
 * says where it does happen rather than a milestone number.
 */
const NEEDS_AN_INTERVIEW = 'A brand-new concept needs the full interview, which runs outside a quarter.';

/**
 * Money that runs backwards.
 *
 * A player asked how to pay off his SBA loan, was told how to borrow, and
 * reasoned his way to `debt -$400k`. It was accepted. The ledger grew a
 * facility with -$400,000 outstanding, drawn on the cash flow statement as a
 * $400k outflow, accruing interest against a negative balance — and every
 * articulation assertion still passed, because a balance sheet ties just as
 * happily around a liability with the wrong sign.
 *
 * The command layer should never send this, and the engine is what makes that
 * true rather than what hopes it. Sign is not a matter of taste: there is no
 * reading of "raise -$400,000 of debt" that the rest of the engine models.
 */
function signIssue(action: Action): string | undefined {
  switch (action.kind) {
    case 'SET_PRICE':
      return action.newPrice <= 0n ? 'A price has to be more than zero.' : undefined;
    case 'SET_MARKETING_SPEND':
      return action.amountPerQuarter < 0n ? 'Marketing spend cannot be negative.' : undefined;
    case 'RAISE_DEBT':
      return action.spec.requestedPrincipal <= 0n
        ? 'Borrowing a negative amount is not a repayment — use REPAY_DEBT.'
        : undefined;
    case 'REPAY_DEBT':
      return action.amount < 0n
        ? 'Repaying a negative amount is not a drawdown — use RAISE_DEBT or DRAW_REVOLVER.'
        : undefined;
    case 'DRAW_REVOLVER':
      return action.amount < 0n ? 'Drawing a negative amount is not a repayment.' : undefined;
    case 'INJECT_CAPITAL':
      return action.amount < 0n ? 'Injecting a negative amount is not a distribution.' : undefined;
    case 'DISTRIBUTE':
      return action.amount < 0n ? 'Distributing a negative amount is not an injection.' : undefined;
    case 'EXPAND_CAPACITY':
      return action.spec.buildoutCost < 0n ? 'A buildout cannot cost less than nothing.' : undefined;
    case 'DISPOSE_ASSET':
      return action.salePrice < 0n ? 'A sale price cannot be negative.' : undefined;
    case 'BUY_SECURITY':
      return action.amount <= 0n ? 'Investing a negative amount is not a sale — use SELL_SECURITY.' : undefined;
    case 'SELL_SECURITY':
      return action.shares <= 0 ? 'Selling a negative number of shares is not a purchase.' : undefined;
    default:
      return undefined;
  }
}

/** Whether an action's own submission was refused, and so should not be scheduled. */
export const wasRefused = (events: readonly EngineEvent[]): boolean =>
  events.some((e) => e.kind === 'ACTION_REJECTED' || e.kind === 'UNDERWRITING_DECLINED');

export interface ApplyContext {
  state: WorldState;
  flows: FlowsByBusiness;
  nextId: () => string;
  /**
   * Gains crystallised by sales this quarter, collected here because they are
   * the household's income and the household settles after every business has.
   */
  realizedGains: Money[];
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

  const sign = signIssue(action);
  if (sign) return [reject(period, action, sign)];

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

    /**
     * Passive investment, out of the household's own cash.
     *
     * Fractional shares, because the player thinks in dollars — "put $1M in the
     * index" — and refusing the remainder would be a rule about brokerages
     * rather than about money. Cost basis is aggregated rather than tracked per
     * lot: it changes the tax on a partial sale and nothing else, and the
     * simplification is said out loud on screen.
     */
    case 'BUY_SECURITY': {
      const security = getSecurity(action.ticker);
      if (!security) return [reject(period, action, `No security called ${action.ticker}.`)];
      const price = priceAt(security, state.config.marketSeed, period);
      if (price <= 0n) return [reject(period, action, `${security.ticker} has no price.`)];

      // Clamped, not refused: "you asked for $2M and have $1.4M" is a fact
      // about the balance, and buying what the cash covers is what was meant.
      const spend =
        action.amount > state.household.cash ? state.household.cash : action.amount;
      if (spend <= 0n) return [reject(period, action, 'The household has no cash to invest.')];

      const shares = Number(spend) / Number(price);
      state.household.cash -= spend;
      const existing = state.household.holdings.find((h) => h.ticker === security.ticker);
      if (existing) {
        existing.shares += shares;
        existing.costBasis += spend;
      } else {
        state.household.holdings.push({ ticker: security.ticker, shares, costBasis: spend });
      }
      return events;
    }

    case 'SELL_SECURITY': {
      const security = getSecurity(action.ticker);
      const holding = state.household.holdings.find((h) => h.ticker === action.ticker.toUpperCase());
      if (!security || !holding) return [reject(period, action, `You do not hold ${action.ticker}.`)];
      const price = priceAt(security, state.config.marketSeed, period);

      const shares = Math.min(action.shares, holding.shares);
      if (shares <= 0) return [reject(period, action, 'Nothing to sell.')];
      const proceeds = mulRate(price, shares);
      // Average cost, taken pro rata. The gain is realised now and taxed with
      // the rest of the household's income this quarter.
      const basisSold = mulRate(holding.costBasis, shares / holding.shares);

      holding.shares -= shares;
      holding.costBasis -= basisSold;
      if (holding.shares <= 1e-9) {
        state.household.holdings = state.household.holdings.filter((h) => h !== holding);
      }
      state.household.cash += proceeds;
      ctx.realizedGains.push(proceeds - basisSold);
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

      // More market, on the same action and the same lead time. Independent of
      // the capacity branches above because a second territory can be either,
      // both, or — for a shop with idle staff and a tapped city — only this.
      if (params.kind === 'UTILIZATION' && action.spec.deltaDemandHoursPerQuarter) {
        params.demandHoursPerQuarter += action.spec.deltaDemandHoursPerQuarter;
      }
      if (params.kind === 'TRAFFIC' && action.spec.deltaAddressableTrafficPerQuarter) {
        params.addressableTrafficPerQuarter += action.spec.deltaAddressableTrafficPerQuarter;
      }

      // A better product: the reference price moves, the price charged does
      // not. Demand reads the ratio, so the improvement arrives as volume
      // until the player decides to take it as rate instead.
      if (action.spec.qualityUpliftPct) {
        params.referencePrice = mulRate(params.referencePrice, 1 + action.spec.qualityUpliftPct);
      }
      return events;
    }

    /**
     * The second one — §9.5.
     *
     * Month-zero outlays at commit, revenue two quarters later, per §9.3.1's
     * table: the building is paid for now and earns nothing until it opens,
     * which is the asymmetry that makes expansion a decision rather than a
     * button.
     */
    case 'START_BUSINESS': {
      if (action.mode !== 'CLONE') return [reject(period, action, NEEDS_AN_INTERVIEW)];
      const spec = action.clone;
      const parent = state.businesses.find((b) => b.id === action.cloneFromId);
      if (!spec) return [reject(period, action, 'A clone needs a name and the money to open it.')];
      if (!parent) return [reject(period, action, `No business ${action.cloneFromId} to clone.`)];
      if (parent.status === 'CLOSED' || parent.status === 'SOLD') {
        return [reject(period, action, `${parent.name} is closed; there is nothing to copy.`)];
      }

      if (phase === 'IMMEDIATE') {
        // The cheque clears now. It is the household's money and it leaves the
        // household, so a player who cannot fund it finds out here rather than
        // two quarters later with a half-built building.
        const needed = cloneOutlay(parent, spec.scale);
        if (spec.equity < needed) {
          return [
            reject(
              period,
              action,
              `Opening that costs ${money(needed)} in buildout alone and you committed ${money(spec.equity)}.`,
            ),
          ];
        }
        if (state.household.cash < spec.equity) {
          return [
            reject(
              period,
              action,
              `The household has ${money(state.household.cash)}, not ${money(spec.equity)}. ` +
                `\`distribute\` moves money out of a business first.`,
            ),
          ];
        }
        state.household.cash -= spec.equity;
        state.household.cumulativeInjections += spec.equity;
        return events;
      }

      const { business } = cloneBusiness(parent, spec, period, ctx.nextId);
      state.businesses.push(business);
      state.household.stakes.push({
        businessId: business.id,
        ownershipPct: 1,
        costBasis: spec.equity,
      });
      return [
        {
          period,
          businessId: business.id,
          kind: 'MILESTONE_REACHED',
          severity: 'INFO',
          detail: { opened: business.name, clonedFrom: parent.name },
        },
      ];
    }

    /**
     * Selling one — §9.3, two quarters to close.
     *
     * The proceeds are the household's, and so is the tax on the gain. A sale
     * is the only way a run converts a decade of operating into money that is
     * actually spendable, and it is the one the benchmark comparison is
     * measured against.
     */
    case 'SELL_BUSINESS': {
      const business = state.businesses.find((b) => b.id === action.businessId);
      if (!business) return [reject(period, action, `Unknown business ${action.businessId}`)];
      if (business.status === 'CLOSED' || business.status === 'SOLD') {
        return [reject(period, action, `${business.name} is already gone.`)];
      }
      if (phase === 'IMMEDIATE') return events;

      const multiple = action.multipleOfEbitda ?? DEFAULT_SALE_MULTIPLE;
      const proceeds = saleValue(business, multiple);
      const basis =
        state.household.stakes.find((s) => s.businessId === business.id)?.costBasis ?? 0n;

      business.status = 'SOLD';
      business.cash = 0n;
      state.household.cash += proceeds;
      ctx.realizedGains.push(proceeds - basis);
      state.household.stakes = state.household.stakes.filter(
        (s) => s.businessId !== business.id,
      );

      return [
        {
          period,
          businessId: business.id,
          kind: 'MILESTONE_REACHED',
          severity: 'INFO',
          detail: {
            sold: business.name,
            proceeds: Number(proceeds) / 100,
            multiple,
          },
        },
      ];
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
