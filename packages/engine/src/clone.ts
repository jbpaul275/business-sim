import { mulRate, sum, type Money } from '@bizsim/money';
import {
  emptyBalances,
  type Business,
  type CloneSpec,
  type PeriodIndex,
  type WorldState,
} from '@bizsim/schemas';

/**
 * A second one — spec §9.5.
 *
 * "I want to use the cash flow from this one to buy a 256 room property in Des
 * Moines" was answered, for most of this project's life, with "you are at 57.6%
 * of capacity". Owning one good business and having nowhere to put its cash is
 * a dead end, and the passive-investing work only half-answered it: an index
 * fund is what you do when you have run out of ideas, not when you have one.
 *
 * §9.5 gives CLONE the job of making a second site take two minutes rather than
 * twenty: the concept, cost structure, working-capital policy and archetype
 * parameters all carry over, and only what genuinely differs is restated.
 *
 * **What differs, here, is size.** The spec lists location, rent, addressable
 * traffic, wage rate, buildout cost and unit count; this build takes one
 * multiplier covering all of them, because the alternative is a second
 * interview and the whole point of a clone is that there isn't one. A player
 * who wants a materially different business has the full interview; a player
 * who wants the same business somewhere else has this.
 *
 * The clone gets §9.5's execution advantage — you have done this before:
 *
 *     clonedRampFloor = min(0.85, rampFloor + 0.10)
 *
 * Written as a `min` against a ceiling above the highest seeded floor, so the
 * bonus can never act as a penalty on an already-experienced operator.
 */

/** §9.5. Above the highest seeded `rampFloor` (0.80), so the bonus never bites. */
export const CLONE_RAMP_CEILING = 0.85;
export const CLONE_RAMP_BONUS = 0.1;

export interface CloneOutcome {
  business: Business;
  /** What opening it consumed, out of the equity committed. */
  outlay: Money;
}

/**
 * Everything the parent knows, with its history left behind.
 *
 * The parent's *structure* is copied and its *state* is not: no cash, no debts,
 * no retained earnings, no accumulated depreciation, no quarters since launch.
 * A clone that inherited its parent's balance sheet would be a second copy of
 * the same money, which is the one thing a second location definitely is not.
 */
export function cloneBusiness(
  parent: Business,
  spec: CloneSpec,
  period: PeriodIndex,
  nextId: () => string,
): CloneOutcome {
  const scale = spec.scale;
  const business = structuredClone(parent) as Business;

  business.id = nextId();
  business.name = spec.name;
  business.foundedPeriod = period;
  business.status = 'OPERATING';
  business.clonedFrom = parent.id;
  delete business.delegation;

  // Volume, scaled. Everything else about the concept — price, elasticity,
  // seasonality, working capital — is what makes it the same business.
  for (const stream of business.streams) {
    stream.id = nextId();
    stream.state = { quartersSinceLaunch: 0 };
    stream.launchPeriod = period;
    stream.modifiers.rampFloor = Math.min(
      CLONE_RAMP_CEILING,
      stream.modifiers.rampFloor + CLONE_RAMP_BONUS,
    );
    const p = stream.params;
    switch (p.kind) {
      case 'TRAFFIC':
        p.addressableTrafficPerQuarter *= scale;
        if (p.capacityModel.kind === 'SEAT_TURNS') {
          p.capacityModel.seats *= scale;
          p.capacityModel.floorAreaSqFt *= scale;
        } else {
          p.capacityModel.transactionsPerHour *= scale;
        }
        break;
      case 'OCCUPANCY':
        p.units *= scale;
        break;
      case 'UTILIZATION':
        p.demandHoursPerQuarter *= scale;
        break;
      case 'PROJECT_BACKLOG':
        p.bidsSubmittedPerQuarter *= scale;
        p.executionCapacityPerQuarter = mulRate(p.executionCapacityPerQuarter, scale);
        break;
      case 'UNITS_CAC':
      case 'SUBSCRIPTION':
        // Acquisition-driven: the size of the second one is set by what is
        // spent on it, not by how big the room is.
        break;
    }
    stream.marketingSpendPerQuarter = mulRate(stream.marketingSpendPerQuarter, scale);
  }

  // Costs scale with the site. Step blocks open where the parent's did, at the
  // new size — a second location does not rediscover its own staffing.
  for (const cost of business.costs.fixedPeriod) {
    cost.amountPerQuarter = mulRate(cost.amountPerQuarter, scale);
  }
  for (const cost of business.costs.stepFixed) {
    // The owner cannot work the line at two sites: a clone hires a real block
    // where the parent had the owner's, or the copy would be quietly staffed
    // by a person who is somewhere else.
    const ownerBlocks = cost.ownerBlocks ?? 0;
    cost.currentBlocks = Math.max(
      cost.minimumBlocks,
      Math.round((cost.currentBlocks + ownerBlocks) * scale),
    );
    cost.ownerBlocks = 0;
    cost.pendingBlocks = 0;
  }
  // A new building, bought new. Depreciation starts now.
  business.assets = business.assets.map((asset) => ({
    ...asset,
    id: nextId(),
    grossCost: mulRate(asset.grossCost, scale),
    acquiredPeriod: period,
    accumulatedDepreciation: 0n,
  }));

  business.debts = [];
  business.balances = emptyBalances();
  business.balances.contributedCapital = spec.equity;
  business.trailingEbitda = [];
  business.trailingDebtService = [];

  const outlay = sum(business.assets.map((a) => a.grossCost));
  business.cash = spec.equity - outlay;
  business.peakCashNeed = outlay;
  business.peakCashNeedPeriod = period;

  return { business, outlay };
}

/**
 * What a clone will cost before the player commits to it.
 *
 * Quoted from the same arithmetic that opens it, so the number on the
 * confirmation and the number that leaves the household cannot disagree.
 */
export const cloneOutlay = (parent: Business, scale: number): Money =>
  sum(parent.assets.map((a) => mulRate(a.grossCost, scale)));

/**
 * What a business is worth, for §9.3's `SELL_BUSINESS`.
 *
 * Trailing four quarters of EBITDA at a multiple, less what it owes. A buyer
 * takes on the debt, so the equity cheque is the enterprise value minus it —
 * and a business worth less than it owes sells for nothing rather than for a
 * negative number, which is what "the bank takes it" looks like.
 */
export function saleValue(business: Business, multiple: number): Money {
  const trailing = sum(business.trailingEbitda.slice(-4));
  const enterprise = trailing > 0n ? mulRate(trailing, multiple) : 0n;
  const debt = sum(business.debts.map((d) => d.outstandingPrincipal));
  const equity = enterprise + business.cash - debt;
  return equity > 0n ? equity : 0n;
}

/** The household's stake in a business, or nothing if it holds none. */
export const stakeIn = (state: WorldState, businessId: string): number =>
  state.household.stakes.find((s) => s.businessId === businessId)?.ownershipPct ?? 1;
