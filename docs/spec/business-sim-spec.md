# Business Simulator — Technical Specification (MVP)

**Version:** 1.0
**Date:** 2026-08-02
**Audience:** Implementing engineer / coding agent

---

## 0. Product Definition

A conversational financial simulator for people considering starting a business. The user describes a business idea in natural language, works with an LLM to build a defensible financial model of it, then operates that business quarter by quarter, taking actions and observing consequences on a full three-statement financial model. At the 10-year mark they receive a summary and can export a live, formula-driven financial model.

**Two things make this different from doing the same exercise in a chat window:**

1. **The numbers are computed by a deterministic engine, not by the LLM.** The model never drifts, always articulates, and can run 40+ periods without degradation.
2. **Every assumption carries provenance.** The exported model shows which inputs are researched, which are benchmark defaults, and which are the user's hopes. This is the thing naive founder models lack and lenders always ask about.

**Primary deliverable to the user:** an `.xlsx` financial model with live formulas, an assumption register, sensitivity analysis, and a peak-cash-need figure.

**Non-goal:** this is a modeling tool, not financial or investment advice. Exported artifacts must carry a disclaimer (see §12.4).

---

## 1. Architecture

### 1.1 The hard rule

> **The LLM never computes a value that appears in a financial statement.**

The LLM's only outputs are (a) *assumptions* — parameters that feed the engine, (b) *classifications* — which archetype, which cost class, and (c) *prose*. Everything numeric downstream is computed by the deterministic engine.

If a value can be derived, deriving it is the engine's job. If the LLM emits a number that the engine could have derived, that's a bug.

### 1.2 Layers

```
┌─────────────────────────────────────────────────────────┐
│  UI (Next.js / React)                                    │
│  Chat pane · Statements pane · Assumption register pane  │
└───────────────┬─────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────┐
│  Orchestrator (server)                                   │
│  Routes player input to the right LLM contract,          │
│  validates structured output, applies to WorldState,     │
│  invokes engine, runs assertions, persists.              │
└──────┬───────────────────────────────────┬──────────────┘
       │                                   │
┌──────▼──────────────────┐   ┌────────────▼──────────────┐
│  LLM Layer              │   │  Deterministic Engine     │
│  5 contracts, each with │   │  Pure TypeScript.         │
│  a strict JSON schema.  │   │  No I/O. No randomness.   │
│  Never sees the ledger. │   │  No LLM calls. No dates.  │
│  Never emits totals.    │   │  tick(state, actions)     │
└─────────────────────────┘   │    → (state', statements) │
                              └───────────────────────────┘
                                           │
                              ┌────────────▼──────────────┐
                              │  Persistence (Postgres)   │
                              │  Event-sourced action log │
                              │  + per-period snapshots   │
                              └───────────────────────────┘
```

### 1.3 Engine purity requirements

The engine package must:

- Have **zero** dependencies except a decimal/money library and `zod`.
- Be a pure function of `(WorldState, Action[]) → (WorldState, StatementSet, AssertionResult[])`.
- Contain **no** randomness, no `Date.now()`, no network, no filesystem.
- Represent all money as **integer minor units (cents)**, never floats. Percentages and rates are floats; anything denominated in currency is `bigint` or a `Money` wrapper over integer cents. Rounding is explicit, half-away-from-zero, applied at the point a computed value becomes a posted amount.

This purity is what makes the whole product testable and what makes 40-period runs trustworthy.

### 1.4 Event sourcing

Persist the ordered list of `Action`s, not just the resulting state. Snapshot `WorldState` at each period boundary for fast loads, but treat the action log as the source of truth — the state must be reproducible by replaying actions from genesis through the engine.

This gives you: deterministic replay, debuggability, the ability to migrate the engine and recompute old games, and a cheap path to a future "what if I hadn't done that" feature.

### 1.5 Recommended stack

| Concern | Choice | Note |
|---|---|---|
| Language | TypeScript, strict mode | Shared types across engine/API/UI |
| Monorepo | pnpm workspaces | `packages/engine`, `packages/schemas`, `apps/web` |
| Money | integer cents via `bigint`, or `dinero.js` | **Never** IEEE floats for currency |
| Schema/validation | `zod` | Single source of truth; derive JSON Schema for LLM structured outputs from the same zod schemas |
| DB | Postgres (Supabase acceptable) | JSONB for `WorldState` snapshots and `BusinessModel` |
| LLM | Any provider with strict structured outputs / tool calling | Must support JSON-schema-constrained generation |
| Export | `exceljs` | **Not** SheetJS community — you need real formula writing |
| Frontend | Next.js App Router, React, Tailwind | |
| Testing | `vitest` + `fast-check` for property tests | |

---

## 2. Core Data Model

All types below are the canonical shapes. Define them once in `packages/schemas` as zod schemas and infer TypeScript types from them.

### 2.1 Time

Periods are **quarters**, zero-indexed from game start.

```ts
type PeriodIndex = number;          // 0 = first operating quarter
const QUARTERS_PER_YEAR = 4;
const DAYS_PER_QUARTER = 91.25;     // used for working-capital day conversions
```

Year one is additionally modeled monthly for export purposes only (§12.2) by interpolating within the quarterly engine result using the seasonality and ramp curves. The engine itself ticks quarterly. Do not build a monthly engine for MVP.

### 2.2 World

```ts
interface WorldState {
  id: string;
  playerId: string;
  createdAtPeriod: 0;
  currentPeriod: PeriodIndex;
  config: WorldConfig;
  household: Household;
  businesses: Business[];
  pendingActions: ScheduledAction[];   // actions with lead time, awaiting effect
  eventLog: EngineEvent[];             // covenant breaches, step additions, crises
}

interface WorldConfig {
  startCapital: Money;                 // 100_000_00 | 1_000_000_00 | custom
  startMode: 'LOW' | 'MID' | 'FREEPLAY';
  milestonePeriod: 39;                 // periods 0..39 = ten years; wrap fires at END of 39
  personalTaxRate: number;             // blended fed+state, default 0.32
  corporateTaxRate: number;            // default 0.21 fed; add state in seed
  primeRate: number;                   // default 0.075; static in MVP (no macro model)
  annualInflationPct: number;          // default 0.025; used only for delegated-business drift
  crisisPolicy: CrisisRemedy[];        // pre-declared ordering, see §9.4
  currency: 'USD';
}
```

### 2.3 Household

The player's personal balance sheet. This exists so that owner draws, personal guarantees, and capital injections are modeled honestly rather than treating the business as the whole world.

```ts
interface Household {
  cash: Money;
  personalDebts: Debt[];               // e.g. HELOC used to fund the business
  stakes: { businessId: string; ownershipPct: number; costBasis: Money }[];
  cumulativeDraws: Money;
  cumulativeInjections: Money;
  cumulativePersonalTax: Money;
  creditQuality: 'GOOD' | 'IMPAIRED';  // set IMPAIRED by insolvency w/ guarantee
  annualLivingExpenses: Money;         // default 60_000_00; drawn from household cash
}
```

**Household living expenses are mandatory and non-zero.** They are drawn from household cash each period. This prevents the common fiction where the founder lives on air for three years. If household cash goes negative, that is a personal insolvency event (§9.4).

### 2.4 Business

```ts
interface Business {
  id: string;
  name: string;
  legalForm: 'SOLE_PROP' | 'LLC_PASSTHROUGH' | 'S_CORP' | 'C_CORP';
  ownershipPct: number;                // player's share; MVP always 1.0
  foundedPeriod: PeriodIndex;
  status: 'PRE_LAUNCH' | 'OPERATING' | 'DELEGATED' | 'CLOSED' | 'SOLD';
  clonedFrom?: string;                 // businessId this was cloned from

  streams: RevenueStream[];            // one or more; see §3
  costs: CostStructure;                // see §4
  workingCapital: WorkingCapitalPolicy;// see §5
  assets: FixedAsset[];
  debts: Debt[];

  cash: Money;
  balances: BusinessBalances;          // AR, inventory, AP, accrued, deferred, equity
  taxState: TaxState;

  assumptions: AssumptionRegister;     // see §10
  delegation?: DelegationState;
}

interface BusinessBalances {
  accountsReceivable: Money;
  inventory: Money;
  prepaidExpenses: Money;              // deposits, prepaid insurance
  accountsPayable: Money;
  accruedLiabilities: Money;
  deferredRevenue: Money;
  deferredOwnerComp: Money;            // accrued when deferred under §9.4
  deferredTaxLiability: Money;         // book/tax difference from §7.3
  retainageReceivable: Money;          // PROJECT_BACKLOG only
  contributedCapital: Money;
  retainedEarnings: Money;
}

interface TaxState {
  nolCarryforward: Money;              // net operating loss carryforward
  section179UsedThisYear: Money;
}
```

### 2.5 Fixed assets

```ts
interface FixedAsset {
  id: string;
  label: string;                        // "Commercial batch freezer, 20qt"
  category: 'EQUIPMENT' | 'LEASEHOLD_IMPROVEMENTS' | 'VEHICLES' | 'REAL_PROPERTY' | 'FF&E';
  grossCost: Money;
  acquiredPeriod: PeriodIndex;
  usefulLifeYears: number;
  accumulatedDepreciation: Money;
  salvageValue: Money;                  // default 0
  replacementCycleYears?: number;       // triggers mandatory replacement capex
  maintenancePctOfGrossPerYear: number; // default by category, see §4.6
  section179Elected: boolean;
}
```

Depreciation is straight-line for MVP: `(grossCost - salvageValue) / (usefulLifeYears * 4)` per quarter, beginning the quarter after acquisition, capped so accumulated depreciation never exceeds `grossCost - salvageValue`.

Default useful lives: `EQUIPMENT` 7, `LEASEHOLD_IMPROVEMENTS` 15 (or lease term if shorter), `VEHICLES` 5, `REAL_PROPERTY` 39, `FF&E` 7.

### 2.6 Debt

```ts
interface Debt {
  id: string;
  label: string;
  kind: 'AMORTIZING' | 'INTEREST_ONLY' | 'REVOLVER' | 'SBA_7A' | 'EQUIPMENT_FINANCE';
  originalPrincipal: Money;
  outstandingPrincipal: Money;
  annualRate: number;
  termQuarters: number;
  originatedPeriod: PeriodIndex;
  originationFeePct: number;
  personalGuarantee: boolean;
  revolverLimit?: Money;
  covenants: Covenant[];
}

interface Covenant {
  metric: 'DSCR' | 'CURRENT_RATIO' | 'DEBT_TO_EBITDA';
  operator: 'GTE' | 'LTE';
  threshold: number;
  testFrequencyQuarters: number;        // typically 4
  breachConsequence: 'RATE_STEP_UP' | 'ACCELERATION' | 'WARNING';
}
```

### 2.7 Money

```ts
type Money = bigint;                    // integer cents. 100_000_00n === $100,000.00
```

Provide helpers: `add`, `sub`, `mulRate(m: Money, r: number): Money` (rounds half-away-from-zero), `pct`, `toDisplay`, `fromDisplay`. **All rate multiplication goes through `mulRate`** so rounding is centralized and testable.

### 2.8 Supporting types

Defined here so no interface elsewhere in this spec references an undefined type.

```ts
type LegalForm = 'SOLE_PROP' | 'LLC_PASSTHROUGH' | 'S_CORP' | 'C_CORP';
type CostClass = 'VARIABLE_REVENUE' | 'VARIABLE_ACTIVITY' | 'STEP_FIXED' | 'FIXED_PERIOD';
type StatementLine = 'COGS' | 'LABOR' | 'OCCUPANCY' | 'MARKETING' | 'G&A';

interface ScheduledAction {
  action: Action;
  submittedPeriod: PeriodIndex;
  effectivePeriod: PeriodIndex;      // submitted + leadTimeQuarters (§9.3.1)
  costAppliedPeriod: PeriodIndex;    // often < effectivePeriod — the asymmetry is the point
}

interface EngineEvent {
  period: PeriodIndex;
  businessId?: string;
  kind: 'STEP_BLOCK_CROSSED' | 'CAPACITY_CONSTRAINED' | 'COVENANT_BREACH'
      | 'LOST_DEMAND_THRESHOLD' | 'RUNWAY_WARNING' | 'CASH_CRISIS' | 'CRISIS_REMEDY_APPLIED'
      | 'INSOLVENCY' | 'ELASTICITY_CLAMP' | 'ASSUMPTION_OUT_OF_BAND' | 'MILESTONE_REACHED';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  detail: Record<string, number | string>;
}

interface StatementSet {
  period: PeriodIndex;
  byBusiness: Record<string, { incomeStatement: IS; balanceSheet: BS; cashFlow: CF }>;
  consolidated: { incomeStatement: IS; balanceSheet: BS; cashFlow: CF };
  household: HouseholdStatement;
  derivedMetrics: DerivedMetrics;    // §8.5
}

interface AssertionResult { name: string; passed: boolean; expected: Money; actual: Money; }

interface AssumptionRegister {
  byId: Record<string, Assumption>;  // Assumption defined in §10.1
  byPath: Record<string, string>;    // model path → assumption id
  confidenceScore: number;           // §10.3
}

interface ChallengeRecord {
  period: PeriodIndex;
  priorValue: number | Money;
  assertedValue: number | Money;
  statedBasis: string | null;
  ruling: 'CONCEDE' | 'PARTIAL' | 'DEFEND' | 'NEED_CLARIFICATION';
  resultingValue: number | Money;
  reasoning: string;
}

interface DelegationState {
  managerCompPerQuarter: Money;
  managerQuality: 'BUDGET' | 'STANDARD' | 'STRONG';  // drives drift rate, §9.6
  delegatedAtPeriod: PeriodIndex;
  cumulativeDriftPct: number;
}

interface FixedAssetSpec {
  label: string; category: FixedAsset['category']; grossCost: Money;
  quantity: number; usefulLifeYears: number; section179Elected: boolean;
}
interface DebtSpec {
  kind: Debt['kind']; requestedPrincipal: Money; termQuarters: number;
  personalGuarantee: boolean;
}
interface CapacitySpec {
  streamId: string; deltaSeats?: number; deltaUnits?: number;
  deltaExecutionCapacity?: Money; buildoutCost: Money;
}
type CrisisRemedy = 'REVOLVER' | 'HOUSEHOLD_INJECTION' | 'FACTOR_AR'
                  | 'DEFER_OWNER_COMP' | 'EMERGENCY_DEBT' | 'SALE_LEASEBACK' | 'INSOLVENCY';
```

`BusinessModel` is the full synthesized model (streams + costs + capex + working capital + financing plan). It is the object §11.2 emits and §9.1 Phase 4 freezes; its authoritative definition is the zod schema in `packages/schemas/businessModel.ts`. `IS`, `BS`, `CF` follow §8.1–8.3 line for line. `Provenance` is defined in §10.1, `StreamState` in §3.7, `DerivedMetrics` in §8.5.

---

## 3. Revenue Archetypes

A `Business` holds one or more `RevenueStream`s. **Archetypes attach to streams, not to businesses.** A gym is `SUBSCRIPTION` (memberships) + `UTILIZATION` (personal training) + `UNITS_CAC` (retail). A restaurant with catering is `TRAFFIC` + `PROJECT_BACKLOG`. This composability is what lets six archetypes cover the space; adding a seventh later is additive rather than a refactor.

```ts
type Archetype =
  | 'TRAFFIC'          // capacity-constrained retail, food service
  | 'UTILIZATION'      // services, agency, trades, professional
  | 'UNITS_CAC'        // product, ecommerce, DTC
  | 'SUBSCRIPTION'     // recurring revenue, memberships
  | 'OCCUPANCY'        // asset yield: storage, rental, laundromat, vending
  | 'PROJECT_BACKLOG'; // construction, contract, custom fabrication

interface RevenueStream {
  id: string;
  label: string;
  archetype: Archetype;
  params: TrafficParams | UtilizationParams | UnitsCacParams
        | SubscriptionParams | OccupancyParams | ProjectParams;
  modifiers: SharedModifierParams;                // §3.0 — registered assumptions
  marketingSpendPerQuarter: Money;                // set per stream; see §3.0.5
  seasonality: [number, number, number, number];  // calendar Q1..Q4, must average 1.0
  launchPeriod: PeriodIndex;
  state: StreamState;                              // mutable carry-forward state
}
```

### 3.0 Shared modifiers

Three modifiers apply across archetypes. Implement once, reuse. Their parameters live in a dedicated interface so every one of them is addressable by `Assumption.path` and therefore satisfies the completeness invariant (§10.2).

```ts
interface SharedModifierParams {
  rampFloor: number;
  rampConstant: number;
  marketingMaxLift: number;
  halfSaturationSpend: Money;
  priceElasticity: number;
}
```

**Common index terms**, defined once and used by all six archetypes:

```
q            = currentPeriod - launchPeriod        // quarters since this stream launched
quarterOfYear = currentPeriod % 4                  // calendar quarter; ALWAYS use this for seasonality
spendRatio   = marketingSpendPerQuarter / baseMarketingSpendPerQuarter
```

Seasonality is indexed by `quarterOfYear`, never by `q`. Indexing by `q` would drift a stream's seasonality out of calendar alignment whenever `launchPeriod % 4 !== 0` — an ice cream shop that opens in Q4 must still get its summer peak in Q3.

**Maturity ramp** — a new location or new business does not hit steady state immediately.

```
maturityRamp(q, rampFloor, rampConstant)
  = rampFloor + (1 - rampFloor) * (1 - exp(-q / rampConstant))
```

Single signature; all callers pass all three arguments from `stream.modifiers`. Defaults: `rampFloor = 0.40`, `rampConstant = 3.0` (reaches ~97% of steady state by quarter 9). Seeded per archetype — `OCCUPANCY` lease-up is slower (`rampConstant = 5.0`), `UTILIZATION` faster if the founder brings a book of business (`rampFloor` up to 0.80).

**Marketing response** — diminishing returns, deterministic, and always displayed alongside any result it drives.

```
marketingMultiplier(spend) = 1 + marketingMaxLift * (1 - exp(-spend / halfSaturationSpend))
```
Defaults: `marketingMaxLift = 0.35`, `halfSaturationSpend` seeded per archetype (food service ~$8,000/quarter). The curve is visible to the player and editable as an assumption. **No stochastic noise in MVP** — but every UI surface reporting a marketing-driven delta must annotate it with the driving assumption and its provenance tag (§10.4).

**Price elasticity** — constant-elasticity form relative to the reference price set at concept lock.

```
priceEffect = clamp(price / referencePrice, 0.4, 3.0) ^ (-priceElasticity)
```

Clamping the *ratio* (not the result) keeps the curve defensible; extrapolating constant elasticity beyond ±3× is not. Emit an `ELASTICITY_CLAMP` event when the player pushes into the bound.

Defaults: `TRAFFIC` 1.2, `UNITS_CAC` 1.5, `SUBSCRIPTION` 0.8, `OCCUPANCY` 1.0, `UTILIZATION` 0.7, `PROJECT_BACKLOG` 1.8 (bid-price sensitivity is high).

#### 3.0.1 Price field mapping

`price` is archetype-specific. `SET_PRICE` (§9.3) targets the field named here, and `referencePrice` is a snapshot of that same field taken at concept lock (§9.1 Phase 4).

| Archetype | `price` field |
|---|---|
| `TRAFFIC` | `avgTicket` |
| `UTILIZATION` | `blendedHourlyRate` |
| `UNITS_CAC` | `avgOrderValue` |
| `SUBSCRIPTION` | `arpuPerQuarter` |
| `OCCUPANCY` | `ratePerUnitPerQuarter` |
| `PROJECT_BACKLOG` | `avgContractValue` (bid price index) |

#### 3.0.2 Which modifiers apply where

Not every modifier applies to every archetype. Exemptions are deliberate:

| Archetype | maturityRamp | marketingMultiplier | priceEffect |
|---|---|---|---|
| `TRAFFIC` | ✓ | ✓ | ✓ |
| `UTILIZATION` | ✓ | ✓ | ✓ |
| `UNITS_CAC` | — (spend, not time, drives acquisition) | ✓ (via CAC) | ✓ |
| `SUBSCRIPTION` | ✓ (on adds) | ✓ (via CAC) | ✓ |
| `OCCUPANCY` | ✓ (lease-up) | — (rate and location drive absorption) | ✓ |
| `PROJECT_BACKLOG` | — (backlog is the ramp) | ✓ (biz dev spend) | ✓ (bid competitiveness) |

#### 3.0.3 Contribution margin

Several archetype-level metrics need a per-stream margin. Business-level gross margin is ambiguous when costs are shared, so define:

```
streamContributionMarginPct
  = 1 - (Σ VARIABLE_REVENUE pct applying to this stream)
      - (Σ VARIABLE_ACTIVITY cost for this stream / streamRevenue)
```

Step-fixed and fixed-period costs are excluded — they are not attributable to a marginal unit. Use `streamContributionMarginPct` in the CAC-payback and LTV/CAC formulas (§3.3, §3.4). Business-level `grossMarginPct` (§8.1) is a different number and is used only for break-even revenue (§8.5).

#### 3.0.5 Marketing spend

Marketing is set **per stream** (`RevenueStream.marketingSpendPerQuarter`). `SET_MARKETING_SPEND` carries a `streamId`. On the income statement it is its own line (`statementLine: 'MARKETING'`), booked in the quarter incurred and never accruable — agencies and platforms bill on short cycles.

For a business with multiple streams, the LLM proposes an initial split at synthesis and the player adjusts per stream thereafter. There is no automatic allocation rule; allocating marketing across lines of business is a real decision and the sim should not make it silently.

---

### 3.1 TRAFFIC — capacity-constrained retail and food service

```ts
interface TrafficParams {
  addressableTrafficPerQuarter: number;  // people passing / in trade area
  captureRate: number;                   // fraction who transact, e.g. 0.012
  avgTicket: Money;
  referencePrice: Money;                 // = avgTicket at lock; used for elasticity
  priceElasticity: number;
  operatingDaysPerQuarter: number;       // default 91
  capacityModel: {
    kind: 'SEAT_TURNS' | 'THROUGHPUT';
    seats?: number;
    turnsPerDay?: number;                // SEAT_TURNS
    transactionsPerHour?: number;        // THROUGHPUT
    operatingHoursPerDay?: number;
  };
  peakConcentration: number;             // fraction of demand in peak hours, default 0.45
  skuCount: number;                      // menu / catalog breadth
  baselineSkuCount: number;              // template's normal breadth, e.g. 40 for a restaurant
  serviceComplexityFactor: number;       // 1.0 = baseline; >1 slows throughput. Derived, see below
}
```

**Tick:**

```
demand = addressableTrafficPerQuarter
       * captureRate
       * marketingMultiplier(marketingSpendPerQuarter)
       * priceEffect
       * maturityRamp(q, rampFloor, rampConstant)
       * seasonality[quarterOfYear]

// Effective capacity, discounted for peak concentration and service complexity
rawCapacity = capacityModel.kind === 'SEAT_TURNS'
  ? seats * turnsPerDay * operatingDaysPerQuarter
  : transactionsPerHour * operatingHoursPerDay * operatingDaysPerQuarter

effectiveCapacity = rawCapacity / serviceComplexityFactor
peakConstrainedCapacity = effectiveCapacity * (1 - 0.5 * max(0, peakConcentration - 0.35))

// Labor also binds — see §4.3. Capacity is the tighter of physical and staffed.
capacity       = min(peakConstrainedCapacity, stepFixedLaborCapacity)
transactions   = min(demand, capacity)
lostDemand     = demand - transactions
revenue        = transactions * avgTicket
```

`lostDemand` must be surfaced to the player and to the narrator. "You turned away 1,840 customers this quarter" is the single most actionable output this archetype produces. It is also the input to step-fixed staffing decisions (§4.3) — **`demand`, not `transactions`, is the step-fixed driver**, and getting that backwards produces a permanent under-staffing trap.

`serviceComplexityFactor` is the hook for the 256-flavor case: 256 SKUs raises per-customer service time, which raises the factor, which lowers throughput, which caps revenue at peak. Derived by the engine (not the LLM) and exposed as an editable assumption:

```
serviceComplexityFactor = 1.0 + 0.10 * log2(max(1, skuCount / baselineSkuCount))
```

At 256 flavors against a 40-SKU baseline that is `1.0 + 0.10 * 2.68 = 1.27` — a 21% throughput haircut. Combined with the inventory and spoilage effects the LLM sets at synthesis (§11.2), that is the mechanism by which the concept becomes conditionally viable rather than simply approved or rejected.

---

### 3.2 UTILIZATION — services, agency, trades

```ts
interface UtilizationParams {
  billableHeadcount: number;             // driven by step-fixed labor blocks
  billableHoursPerHeadPerQuarter: number;// default 480 (≈37 hrs/wk × 13 wks)
  targetUtilization: number;             // default 0.70
  blendedHourlyRate: Money;
  referencePrice: Money;
  priceElasticity: number;
  realizationRate: number;               // billed hours actually collected, default 0.90
  demandHoursPerQuarter: number;         // market demand at reference price
}
```

**Tick:**

```
grossCapacityHours = billableHeadcount * billableHoursPerHeadPerQuarter
demandHours = demandHoursPerQuarter
            * marketingMultiplier(marketingSpendPerQuarter)
            * priceEffect
            * maturityRamp(q, rampFloor, rampConstant)
            * seasonality[quarterOfYear]

// Cap at gross capacity, NOT at target utilization — a team can run hot in a good
// quarter, and §8.5 break-even utilization and §9.4 post-mortems both need
// realizedUtilization to be able to exceed target.
billableHours       = min(demandHours, grossCapacityHours)
realizedUtilization = billableHours / grossCapacityHours
revenue             = billableHours * blendedHourlyRate * realizationRate
benchStress         = max(0, grossCapacityHours * targetUtilization - billableHours)
```

`targetUtilization` is a **planning reference** used for staffing decisions (§4.3) and for the bench-stress metric — not a hard cap on delivery. Sustained `realizedUtilization` above ~0.85 should raise a `CAPACITY_CONSTRAINED` event; in reality that is where burnout and quality problems begin.

`realizationRate` — the gap between hours worked and hours actually paid for — is the number services founders most reliably forget. Never default it to 1.0.

`benchStress > 0` means paid staff sitting idle; surface it. This is the archetype's characteristic failure mode: you hire ahead of demand and the fixed labor cost eats you.

---

### 3.3 UNITS_CAC — product, ecommerce, DTC

```ts
interface UnitsCacParams {
  baseCac: Money;
  baseMarketingSpendPerQuarter: Money;   // spend level at which baseCac holds
  cacInflationCoefficient: number;       // default 0.35 — CAC rises as you scale spend
  avgOrderValue: Money;
  referencePrice: Money;
  priceElasticity: number;
  ordersPerNewCustomerFirstQuarter: number;  // default 1.0
  repeatPurchaseRatePerQuarter: number;      // fraction of existing base ordering, default 0.25
  quarterlyCustomerAttrition: number;        // default 0.12
}
```

**Tick:**

```
// Spending more to acquire more gets progressively more expensive
effectiveCac  = baseCac * (1 + cacInflationCoefficient * max(0, spendRatio - 1))
newCustomers  = marketingSpendPerQuarter / effectiveCac

beginCustomers = state.customers            // prior period's ending value
repeatOrders   = beginCustomers * repeatPurchaseRatePerQuarter * seasonality[quarterOfYear]
newOrders      = newCustomers * ordersPerNewCustomerFirstQuarter
orders         = (newOrders + repeatOrders) * priceEffect
revenue        = orders * avgOrderValue

state.customers = (beginCustomers + newCustomers) * (1 - quarterlyCustomerAttrition)
```

`cacInflationCoefficient` is essential. Without it, the optimal strategy is always "spend infinite marketing," and the model becomes a money printer. With it, the marginal-CAC wall appears naturally and the player has to find their efficient frontier.

`state.customers` (§3.7) holds the ending count; the beginning count for any period is simply the prior period's stored value. Also compute and expose **CAC payback in quarters**:

```
ordersPerCustomerPerQuarter = repeatPurchaseRatePerQuarter
paybackQuarters = effectiveCac
                / (avgOrderValue * streamContributionMarginPct * ordersPerCustomerPerQuarter)
```

using `streamContributionMarginPct` from §3.0.3.

---

### 3.4 SUBSCRIPTION — recurring revenue and memberships

```ts
interface SubscriptionParams {
  baseCac: Money;
  baseMarketingSpendPerQuarter: Money;
  cacInflationCoefficient: number;       // default 0.30
  arpuPerQuarter: Money;
  referencePrice: Money;
  priceElasticity: number;
  quarterlyChurnRate: number;            // default 0.10 consumer, 0.03 B2B
  setupFee: Money;                       // default 0
  netRevenueRetention: number;           // expansion on surviving base, default 1.0
  prepayMonths: number;                  // drives deferred revenue, default 0
}
```

**Tick:**

```
effectiveCac  = baseCac * (1 + cacInflationCoefficient * max(0, spendRatio - 1))
adds          = (marketingSpendPerQuarter / effectiveCac) * priceEffect
              * maturityRamp(q, rampFloor, rampConstant) * seasonality[quarterOfYear]

beginSubs     = state.subscribers          // prior period's ending value
churned       = beginSubs * quarterlyChurnRate
state.subscribers = beginSubs + adds - churned
avgSubs       = (beginSubs + state.subscribers) / 2

subscriptionRevenue = avgSubs * arpuPerQuarter * netRevenueRetention
setupRevenue        = adds * setupFee
revenue             = subscriptionRevenue + setupRevenue
```

**`subscriptionRevenue` — including `netRevenueRetention` and excluding `setupRevenue` — is the figure the deferred revenue rollforward in §5.3 recognizes.** Setup fees are earned on delivery and are never deferred. The two sections must use this one definition or the deferred-revenue balance will not tie.

If `prepayMonths > 0`, cash collected exceeds revenue recognized; the difference accrues to `deferredRevenue` (§5.3). Prepayment is a genuine working-capital *advantage* and modeling it correctly is one of the more instructive outputs of the sim.

Expose **LTV/CAC** = `(arpuPerQuarter * streamContributionMarginPct / quarterlyChurnRate) / effectiveCac` and flag when it falls below 3.0.

---

### 3.5 OCCUPANCY — asset yield

Storage, rental property, laundromats, car washes, vending routes, parking, equipment leasing.

```ts
interface OccupancyParams {
  units: number;                         // storage units, apartments, machines, bays
  stabilizedOccupancy: number;            // default 0.88
  ratePerUnitPerQuarter: Money;
  referencePrice: Money;
  priceElasticity: number;
  concessionsPct: number;                 // free-month promos, default 0.04
  ancillaryRevenuePctOfBase: number;      // late fees, insurance, retail; default 0.08
}
```

Lease-up speed is expressed as `modifiers.rampConstant` (default 5.0 for this archetype), not as a separate parameter — one source of truth.

**Tick:**

```
occupancy = stabilizedOccupancy
          * maturityRamp(q, rampFloor, rampConstant)
          * priceEffect
          * seasonality[quarterOfYear]
occupancy = clamp(occupancy, 0, 1.0)

occupiedUnits = units * occupancy
baseRevenue   = occupiedUnits * ratePerUnitPerQuarter * (1 - concessionsPct)
ancillary     = baseRevenue * ancillaryRevenuePctOfBase
revenue       = baseRevenue + ancillary
```

Bad debt is **not** applied here. It is injected once as a `VARIABLE_REVENUE` cost line by the omission guard (§4.6); applying it in both places would double-count it.

`units` is changed only by capex actions with lead time (build/acquire more units), which makes this archetype's growth explicitly lumpy and capital-intensive — correctly so.

Note for the cost engine: this archetype is dominated by fixed-period costs and capex with very low variable cost. That produces high operating leverage — small occupancy changes swing net income hard. Surface a break-even occupancy figure; it is the key operating metric for these businesses.

---

### 3.6 PROJECT_BACKLOG — construction, contract, custom work

```ts
interface ProjectParams {
  bidsSubmittedPerQuarter: number;
  winRate: number;                        // default 0.20
  avgContractValue: Money;
  referencePrice: Money;                  // bid price index; elasticity is bid competitiveness
  priceElasticity: number;                // default 1.8 — high
  executionCapacityPerQuarter: Money;     // revenue-equivalent work the crew can complete
  retainagePct: number;                   // default 0.10
  retainageReleaseLagQuarters: number;    // default 2
  progressBillingLagDays: number;         // default 45 — this stream's DSO; overrides §5.1
  changeOrderPctOfContract: number;       // default 0.06
  bizDevSpendPerQuarter: Money;           // this archetype's marketing analogue
}
```

**Tick:**

```
effectiveWinRate = clamp(winRate * priceEffect * marketingMultiplier(bizDevSpendPerQuarter), 0, 1)
wins             = bidsSubmittedPerQuarter * effectiveWinRate
newBacklog       = wins * avgContractValue * (1 + changeOrderPctOfContract)

beginBacklog      = state.backlog                      // prior period's ending value
backlogAvailable  = beginBacklog + newBacklog
revenueRecognized = min(backlogAvailable, executionCapacityPerQuarter)  // percentage-of-completion
state.backlog     = backlogAvailable - revenueRecognized

// Cash mechanics — this is the point of this archetype
retainageWithheld = revenueRecognized * retainagePct
retainageReleased = Σ over state.retainageSchedule where period === currentPeriod
state.retainageSchedule.push({
  period: currentPeriod + retainageReleaseLagQuarters,
  amount: retainageWithheld
})

// Rollforward — this balance is part of ΔNWC (§5.2)
retainageReceivable_end = retainageReceivable_begin + retainageWithheld - retainageReleased

revenue = revenueRecognized
```

**The win-rate clamp is required, not cosmetic.** With `priceElasticity = 1.8` and the ratio clamp floor of 0.4, `priceEffect` reaches `0.4^-1.8 ≈ 5.3`; unclamped, `0.20 × 5.3 × 1.35 = 1.43` — a 143% win rate. Bidding low must raise win rate asymptotically toward 1.0, never past it.

Ordinary AR for this stream uses `progressBillingLagDays` as its DSO rather than the business-level `dsoDays` (§5.1); contractors bill on schedules of value, not invoices. Where a business mixes a `PROJECT_BACKLOG` stream with others, compute AR per stream and sum.

The characteristic dynamic: you recognize revenue and pay subs and labor **now**, bill on a lag, and 10% of every dollar is withheld for two more quarters. A growing contractor with a healthy P&L runs out of cash. This archetype exists specifically to make that visible, and it is the most persuasive demonstration in the product that income and cash are different things.

Track `retainageReceivable` on the balance sheet separately from ordinary AR. Surface **backlog coverage in quarters** = `state.backlog / executionCapacityPerQuarter` as a leading indicator.

---

### 3.7 Stream state carried between periods

```ts
interface StreamState {
  quartersSinceLaunch: number;
  customers?: number;          // UNITS_CAC
  subscribers?: number;        // SUBSCRIPTION
  backlog?: Money;             // PROJECT_BACKLOG
  retainageSchedule?: { period: PeriodIndex; amount: Money }[];  // PROJECT_BACKLOG
  currentOccupancy?: number;   // OCCUPANCY
  cumulativeLostDemand?: number; // TRAFFIC
}
```

### 3.8 Archetype selection rules for the LLM

Given a business description, choose the archetype whose **primary constraint** matches:

| If the binding constraint is… | Archetype |
|---|---|
| Physical throughput of a location customers walk into | `TRAFFIC` |
| Hours of skilled people you can sell | `UTILIZATION` |
| How much you can spend to acquire a buyer | `UNITS_CAC` |
| Retaining a paying base over time | `SUBSCRIPTION` |
| Filling a fixed stock of physical units | `OCCUPANCY` |
| Winning and delivering discrete contracts | `PROJECT_BACKLOG` |

Deferred to post-MVP (do not implement; map to nearest neighbor and flag the approximation to the player): marketplace take-rate (GMV × rate), lending spread (balance × spread − loss rate), agricultural yield (harvest × exogenous price with biological lag).

---

## 4. Cost Engine

**Costs decompose by *behavior*, not by industry.** One universal engine serves all six archetypes. Industry knowledge lives in **seed templates** (§4.7) that populate the engine's parameters, not in the engine itself. This is what prevents a 6 × 6 combinatorial mess.

```ts
interface CostStructure {
  variableWithRevenue: VariableRevenueCost[];
  variableWithActivity: VariableActivityCost[];
  stepFixed: StepFixedCost[];
  fixedPeriod: FixedPeriodCost[];
  // capex lives on Business.assets; financing lives on Business.debts
}
```

### 4.1 Variable with revenue

Scales directly with revenue dollars. COGS, food cost, materials, payment processing, sales commissions, franchise royalties.

```ts
interface VariableRevenueCost {
  id: string;
  label: string;
  pctOfRevenue: number;
  appliesToStreamIds: string[] | 'ALL';
  statementLine: StatementLine;    // §2.8
  accruable: boolean;              // true → flows through accounts payable
}
```

```
cost = Σ over applicable streams (streamRevenue * pctOfRevenue)
```

Payment processing is a mandatory injected line for `TRAFFIC` and `UNITS_CAC` (§4.6). The engine folds card mix into the rate at injection time — `pctOfRevenue = processingRate * cardMixPct`, defaults 0.028 × 0.85 = 0.0238 for retail — and registers `processingRate` and `cardMixPct` as separate challengeable assumptions so the player can argue either.

### 4.2 Variable with activity

Scales with a **volume driver** that is decoupled from price. Shipping and fulfillment per order, fuel per delivery, laundry per occupied room, packaging per unit.

```ts
interface VariableActivityCost {
  id: string;
  label: string;
  costPerUnit: Money;
  driver: ActivityDriver;
  statementLine: StatementLine;    // §2.8
  accruable: boolean;
}

type ActivityDriver = 'TRANSACTIONS' | 'ORDERS' | 'BILLABLE_HOURS'
                    | 'OCCUPIED_UNITS' | 'PROJECTS_ACTIVE' | 'REVENUE';
```

Activity drivers are evaluated on **realized** volume — you only pay to ship an order you actually shipped. This is the opposite of the step-fixed rule in §4.3, and the distinction is load-bearing.

This class matters because it breaks the naive "everything is a percentage of revenue" model. If the player raises prices, revenue-linked costs rise but activity-linked costs do not — which is exactly why price increases are so powerful and why the distinction must exist in the engine.

### 4.3 Step-fixed — the important one

You cannot hire 0.4 of a cook. The 401st storage unit requires a new building. Adding the second shift costs a full shift before you have the volume to fill it.

```ts
interface StepFixedCost {
  id: string;
  label: string;                    // "Line cook"
  blockCostPerQuarter: Money;       // base cost; payroll load applied at compute time if isLabor
  capacityPerBlock: number;         // units of driver one block supports
  driver: 'TRANSACTIONS' | 'BILLABLE_HOURS' | 'OCCUPIED_UNITS' | 'REVENUE' | 'PROJECTS_ACTIVE';
  minimumBlocks: number;            // you need at least one manager regardless
  currentBlocks: number;
  addLeadTimeQuarters: number;      // default 1 — hiring is not instant
  removeSeverancePerBlock: Money;   // default = 4 weeks of blockCost
  isLabor: boolean;                 // if true, payroll load auto-applied
  statementLine: StatementLine;     // §2.8
}
```

**Resolution:**

```
// blocksNeeded is computed from UNCONSTRAINED DEMAND, never from realized volume.
blocksNeeded = max(minimumBlocks, ceil(demandVolume / capacityPerBlock))

blocksActive = currentBlocks                      // what you actually have this quarter
cost         = blocksActive * blockCostPerQuarter * (isLabor ? 1 + payrollLoadPct : 1)

// Staffed capacity feeds back into the revenue tick as a binding constraint
stepFixedLaborCapacity = blocksActive * capacityPerBlock
if (blocksActive < blocksNeeded) → emit CAPACITY_CONSTRAINED
```

> **Critical: `blocksNeeded` must be driven by unconstrained demand, not by realized transactions.**
>
> Realized volume is already capped by staffing. Feeding it back in as the staffing driver creates a self-reinforcing trap — the business locks at whatever headcount it started with and can never justify growing, because the demand signal it would need has already been clipped by the shortage it is trying to fix. A 40-quarter simulation of this spec reproduced exactly that failure: revenue froze at the initial staffing ceiling for ten straight years while true demand ran 3× higher. Switching the driver to `demand` resolved it immediately.
>
> This is the single easiest way to ship a subtly broken engine. Add a regression test.

Two further rules, both easy to get wrong:

1. **Blocks do not auto-scale.** The engine computes `blocksNeeded` and reports the gap, but adding a block is a **player action** with `addLeadTimeQuarters` delay. Auto-hiring removes the decision and the tension. The exception is `DELEGATED` businesses (§9.6), where a manager auto-adds blocks to meet demand at a margin cost.
2. **Cost begins when the block is added, capacity arrives after the lead time.** You pay the cook for a quarter before they raise throughput. This asymmetry is the whole point of the class.

The characteristic dynamic: growth is lumpy and margin collapses right at each step. Surface it — when a step is crossed, emit an `EngineEvent` and let the narrator name it. Actual operators find this the most recognizable behavior in the model.

### 4.4 Fixed period

Contractual, time-based, largely independent of volume. Rent, insurance, software, base salaries, accounting, licenses.

```ts
interface FixedPeriodCost {
  id: string;
  label: string;
  amountPerQuarter: Money;
  annualEscalatorPct: number;       // rent bumps are a contract term, not a guess
  startPeriod: PeriodIndex;
  endPeriod?: PeriodIndex;          // lease expiry
  renewalBehavior: 'AUTO_RENEW_AT_MARKET' | 'AUTO_RENEW_AT_ESCALATOR' | 'EXPIRES';
  statementLine: StatementLine;     // §2.8 — rent → OCCUPANCY, salaries → LABOR, etc.
  accruable: boolean;
  isLabor: boolean;
}
```

```
amountThisPeriod = amountPerQuarter * (1 + annualEscalatorPct) ^ floor((currentPeriod - startPeriod) / 4)
```

### 4.5 Payroll load — applied automatically, never optional

Every cost line with `isLabor: true` is multiplied by `(1 + payrollLoadPct)` at computation time.

```
payrollLoadPct = employerFica (0.0765)
               + unemploymentInsurance (default 0.015)
               + workersComp (seeded by industry, 0.01–0.08)
               + benefitsLoad (default 0.15 if offered, 0 if not)
```

Resulting range: **0.10–0.17 without benefits** (typical 0.13), **0.25–0.32 with** (typical 0.28). Seeded per industry — a restaurant's or roofer's workers comp is many times an agency's, which is why the band is wide. Assert in tests that the stated defaults equal the sum of their components; a hardcoded total that its own parts cannot reproduce is a documentation bug waiting to become a code bug.

This is applied by the engine, not entered by the LLM or the player. Founders model `$20/hr` and the real number is `$26/hr`; the engine must not let that error through. The load rate is itself a registered assumption (visible, challengeable), but it cannot be set to zero.

### 4.6 The omission guard — mandatory injected cost lines

At concept lock, the engine injects the following lines into every business unless the player **explicitly** acknowledges and zeroes each one. The acknowledgment is recorded in the assumption register as `player_assumed` and flagged in the export.

| Line | Class | Default | Applies to |
|---|---|---|---|
| **Owner compensation** | `FIXED_PERIOD`, labor, `G&A` | Market rate for the role, min $45k/yr | All |
| Maintenance reserve | `FIXED_PERIOD`, `G&A` | Per-category rate × gross PP&E (see below) | Any with PP&E |
| General liability insurance | `FIXED_PERIOD`, `G&A` | Seeded by industry | All |
| Property / contents insurance | `FIXED_PERIOD`, `OCCUPANCY` | Seeded | Any with a location |
| Workers compensation | folded into payroll load (§4.5) | Seeded | Any with employees |
| Accounting & legal | `FIXED_PERIOD`, `G&A` | $3,500–12,000/yr by entity complexity | All |
| Software / POS / subscriptions | `FIXED_PERIOD`, `G&A` | Seeded | All |
| Credit card processing | `VARIABLE_REVENUE`, `G&A` | processing rate × card mix (§4.1) | `TRAFFIC`, `UNITS_CAC` |
| Repairs & maintenance | `VARIABLE_REVENUE`, `OCCUPANCY` | Seeded | Any with a location |
| Utilities | `FIXED_PERIOD`, `OCCUPANCY` | Seeded by sq ft and industry | Any with a location |
| Bad debt / shrinkage | `VARIABLE_REVENUE`, `G&A` | 0.5–2% | `TRAFFIC`, `OCCUPANCY` |
| Permits & licenses | `FIXED_PERIOD`, `G&A` | Seeded | All |

**Maintenance has exactly one mechanism.** `FixedAsset.maintenancePctOfGrossPerYear` (§2.5) is the *source of the rate*; the omission guard reads it and injects a single `FIXED_PERIOD` cost line. The asset field is never separately expensed — doing both double-counts maintenance in the P&L. Per-category annual defaults:

| Category | Rate |
|---|---|
| `EQUIPMENT` | 4.0% |
| `LEASEHOLD_IMPROVEMENTS` | 1.5% |
| `VEHICLES` | 6.0% |
| `REAL_PROPERTY` | 2.0% |
| `FF&E` | 3.0% |

```
maintenanceCapex = Σ over assets (grossCost * maintenancePctOfGrossPerYear) / 4
```

This is the value §6.3 uses in the DSCR add-back, and it is the only place the number is computed.

**Owner compensation is the single most important line here.** Without it, every model shows phantom profit because the founder is working free, and the resulting projection is not comparable to a job offer. If the player zeroes it, the export must state prominently that the model excludes owner compensation.

### 4.7 Seed templates

A seed template is a named bundle of default parameter values plus benchmark bands. Store as data (JSON), not code, so they can be revised without a deploy.

```ts
interface SeedTemplate {
  id: string;                        // 'full_service_restaurant'
  label: string;
  naicsCode?: string;
  defaultArchetypes: Archetype[];
  costDefaults: {
    lineId: string;
    class: CostClass;                // §2.8
    statementLine: StatementLine;
    value: number | Money;           // rates are number, amounts are Money
    benchmarkBand: { low: number; high: number };
    sourceNote: string;              // "IBISWorld / NRA Operations Report"
  }[];
  streamParamDefaults: Record<string, number | Money>;
  modifierDefaults: SharedModifierParams;
  workingCapitalDefaults: WorkingCapitalPolicy;
  payrollLoadPct: number;
  typicalCapex: { label: string; cost: Money; usefulLifeYears: number }[];
}
```

Ship MVP with **at least 12** seed templates covering the six archetypes: full-service restaurant, quick-service / counter-service food, retail shop, coffee shop, professional services firm, marketing agency, trades contractor (HVAC/plumbing), general contractor, ecommerce/DTC brand, SaaS, gym/fitness studio, self-storage. Add laundromat and short-term rental if time permits.

**The benchmark bands do double duty.** They seed the model, and they power the cost-side pushback loop: when a player's assumption falls outside the band, the sim challenges it —

> *"Your labor is 44% of revenue. Median for full-service restaurants is 30–35%. What's driving that — higher wages, lower volume than modeled, or over-staffing?"*

Founders are usually most wrong on the cost side, and this converts the register into an active reviewer rather than a passive log.

---

## 5. Working Capital and Timing

Amounts are only half of a cost. **Timing is where the cash drama lives**, and it is what separates this from a P&L toy.

```ts
interface WorkingCapitalPolicy {
  dsoDays: number;                    // days sales outstanding; 0 for cash businesses
  dioDays: number;                    // days inventory outstanding
  dpoDays: number;                    // days payable outstanding
  prepaidInsuranceMonths: number;     // default 6
  securityDepositMonths: number;      // default 1 → first + last + security = 3 months at signing
  customerDepositPct: number;         // PROJECT_BACKLOG mobilization deposit, % of contract,
                                      // collected at win, offsets retainage drag. Default 0.05
}
```

### 5.1 Balance computation

Computed on ending balances each quarter, using `DAYS_PER_QUARTER = 91.25`:

```
// AR is computed per stream, because PROJECT_BACKLOG uses progressBillingLagDays (§3.6)
AR_end        = Σ over streams (streamRevenue * (streamDsoDays / 91.25))
Inventory_end = quarterCOGS           * (dioDays / 91.25)
AP_end        = quarterAccruableCosts * (dpoDays / 91.25)
```

where `quarterAccruableCosts` is the sum of all cost lines with `accruable: true`. **Labor is never accruable, and neither is marketing** — payroll clears on a two-week cycle and ad platforms bill on a card, regardless of when customers pay. That mismatch is the mechanism by which growing businesses die.

### 5.2 The working capital delta

```
ΔNWC = (AR_end        - AR_begin)
     + (Retainage_end - Retainage_begin)      // §3.6; omitting this breaks the CF tie
     + (Inv_end       - Inv_begin)
     + (Prepaid_end   - Prepaid_begin)
     - (AP_end        - AP_begin)
     - (Accrued_end   - Accrued_begin)
     - (Deferred_end  - Deferred_begin)
```

Retainage receivable is a current asset that grows every quarter a contractor grows. If it is left out of ΔNWC, `endingCash === beginningCash + CFO + CFI + CFF` (§8.4) cannot hold for any `PROJECT_BACKLOG` business.

`ΔNWC` is subtracted in cash flow from operations. Growth makes it positive, which consumes cash. **This single line is the reason a profitable business runs out of money**, and the UI should be able to trace it explicitly on demand.

### 5.3 Deferred revenue

For `SUBSCRIPTION` with `prepayMonths > 0`:

```
// Prepay is collected from NEW subscribers and from RENEWALS. Omitting renewals
// drains the deferred balance to negative within a few years.
renewals       = beginSubs * (1 - quarterlyChurnRate) * (3 / max(3, prepayMonths))
cashCollected  = (adds + renewals) * arpuPerQuarter * (prepayMonths / 3)

// Must match §3.4 exactly: excludes setup fees, includes netRevenueRetention
revenueRecognized   = avgSubs * arpuPerQuarter * netRevenueRetention
deferredRevenue_end = max(0, deferredRevenue_begin + cashCollected - revenueRecognized)
```

`prepayMonths` lives on `SubscriptionParams` (§3.4) and is read from there; there is no separate working-capital copy of it.

Deferred revenue is a **liability that funds operations**. It is negative working capital, and it is one of the genuinely good outputs of the sim: it shows a founder why annual prepay is worth a discount.

### 5.4 Month-zero cash outlays

At concept lock, before period 0 ticks, the following hit cash immediately. These are routinely omitted from founder models and materially change peak cash need:

- Lease signing: first month + last month + security deposit = `securityDepositMonths + 2` months of rent (3 at the default)
- Leasehold improvements / buildout (capitalized, but cash out now)
- Equipment purchase or down payment
- Initial inventory fill (`dioDays` worth of COGS at planned run rate)
- Permits, licenses, legal formation
- Prepaid insurance (`prepaidInsuranceMonths`)
- Pre-opening payroll and training (typically 2–6 weeks before revenue)
- Pre-opening marketing
- Debt origination fees

Compute and display **peak cash need** and the period in which it occurs as a headline output. Formally: `peakCashNeed = max over periods of (cumulative negative cash position before financing)`. It is the most useful single number a prospective founder can be handed, and almost nobody computes it.

---

## 6. Financing

### 6.1 Amortizing debt

Standard annuity payment per quarter:

```
r = annualRate / 4
payment = principal * r / (1 - (1 + r)^(-termQuarters))

interestPortion  = outstandingPrincipal * r        // → income statement
principalPortion = payment - interestPortion       // → financing cash flow, NOT an expense
```

The interest/principal split must be modeled correctly and shown to the player. The belief that "my loan payment is an expense" is one of the most common and most damaging errors in founder financial thinking, and this is a place where the sim can teach directly.

### 6.2 Debt products

| Kind | Rate default | Term | Notes |
|---|---|---|---|
| `SBA_7A` | Prime + 3.0% (~10.5%) | 40q working capital, 100q real estate | Personal guarantee **required**; ~3% guarantee fee; the realistic default for small business |
| `EQUIPMENT_FINANCE` | 8–12% | Asset useful life | Secured by the equipment; easier approval |
| `REVOLVER` | Prime + 2% | Revolving | Interest on drawn balance only; unused-line fee 0.25%; the cash-crisis backstop |
| `AMORTIZING` | 7–10% | Variable | Conventional term loan |
| `INTEREST_ONLY` | 6–9% | Balloon at term | Common for real property |

Store the prime rate as a `WorldConfig` constant for MVP (no macro model). Default 7.5%.

### 6.3 Underwriting gate

The player cannot simply grant themselves debt. A `RAISE_DEBT` action is tested against:

```
DSCR = trailing 4q EBITDA / trailing 4q debt service (incl. the new facility)
```

Do **not** subtract owner compensation or maintenance here. Both already sit above EBITDA — owner comp in `G&A` and the maintenance reserve as a `FIXED_PERIOD` line (§4.6) — so subtracting them again double-counts. If you prefer the lender convention of underwriting on pre-owner-comp cash flow, add owner comp *back* first and say so explicitly; do not subtract it twice.

- `DSCR >= 1.25` → approved at stated rate
- `1.10 <= DSCR < 1.25` → approved with rate step-up of +150bps and personal guarantee required
- `DSCR < 1.10` → declined; the narrator explains why and what would change it

For a pre-revenue business there is no trailing EBITDA, so underwrite on: collateral coverage (advance rate 60% on equipment, 70% on real property), owner equity injection (SBA requires ≥10%), and `creditQuality`. This correctly makes the first loan hard and later loans easier — matching reality and creating a real progression arc.

### 6.4 Covenants

Test at `testFrequencyQuarters`. On breach:

- `WARNING` → `EngineEvent`, narrator raises it
- `RATE_STEP_UP` → `annualRate += 0.02`
- `ACCELERATION` → full principal becomes due; typically triggers a cash crisis (§9.4)

### 6.5 Personal guarantee

If `personalGuarantee: true` and the business becomes insolvent, the unpaid principal attaches to `Household` as a personal debt and sets `creditQuality = 'IMPAIRED'`, which raises all future borrowing rates by 300bps and blocks `SBA_7A` for 8 quarters. This is the real trap of small-business lending and it should not be softened.

---

## 7. Tax

Keep it simple but structurally honest.

### 7.1 By entity form

**Pass-through** (`SOLE_PROP`, `LLC_PASSTHROUGH`, `S_CORP`): the business pays no entity-level income tax. Taxable income flows to `Household` and is taxed at `config.personalTaxRate`. Model the cash effect as a mandatory **tax distribution** from the business to the household in the quarter the tax is owed — otherwise the model shows cash the founder does not actually have.

For `SOLE_PROP` and `LLC_PASSTHROUGH`, additionally apply **self-employment tax** of 15.3% on the first $168,600 of net earnings and 2.9% above. `S_CORP` avoids SE tax on distributions but requires reasonable owner W-2 comp — enforce that `ownerCompensation > 0` for `S_CORP`.

**C-corp**: taxed at `config.corporateTaxRate` (21% federal + state seed). Distributions to the household are then taxed again at the qualified dividend rate (15%/20%). Model both layers; the double taxation is the reason almost no small business should elect C-corp, and the sim should let a player discover that.

### 7.2 NOL carryforward

```
taxableIncome = max(0, pretaxIncome - min(nolCarryforward, 0.80 * pretaxIncome))
nolCarryforward' = nolCarryforward - nolUsed + max(0, -pretaxIncome)
```

Cheap to implement, large effect. Early-year losses shield later income, which materially changes the 10-year picture and rewards patient builds.

### 7.3 Section 179 / bonus depreciation

Allow the player to elect immediate expensing of equipment up to the §179 cap (seed: $1,220,000, phasing out above $3,050,000 of purchases). Elected assets get zero book depreciation and a full first-year tax deduction, tracked as a book/tax difference.

For MVP, do **not** build a full deferred-tax-liability schedule. Instead, keep book depreciation on the income statement and compute tax on a separate tax-basis income figure, carrying the difference in a single `deferredTaxLiability` balance-sheet line. Document this simplification in the export.

Meaningful year-one cash effect, and it is a real decision founders face.

---

## 8. Financial Statements and Articulation

### 8.1 Income statement

```
  Revenue                                    Σ stream revenues
- Cost of goods sold                         VARIABLE_REVENUE + VARIABLE_ACTIVITY where line = COGS
= Gross profit
- Labor                                      STEP_FIXED(isLabor) + FIXED_PERIOD(isLabor), incl. payroll load
- Occupancy                                  rent, utilities, property insurance
- Marketing                                  player-set spend
- General & administrative                   remaining OPEX incl. owner comp
= EBITDA
- Depreciation & amortization
= EBIT
- Interest expense
= Pre-tax income
- Income tax expense                         C_CORP only — see below
= Net income
```

**The tax line is conditional on entity form.** For `C_CORP`, entity-level tax is an expense here. For pass-through forms (`SOLE_PROP`, `LLC_PASSTHROUGH`, `S_CORP`) the business owes no entity-level tax; it makes a **tax distribution** to the household instead (§7.1), which is a financing outflow and a reduction of retained earnings — not an expense. Booking both would double-count and break the retained-earnings assertion in §8.4.

Cost lines map to statement lines via `statementLine` (§2.8), which is why that field must carry `LABOR | OCCUPANCY | MARKETING | G&A` rather than a single undifferentiated `OPEX`.

### 8.2 Balance sheet

```
ASSETS
  Cash
  Accounts receivable
  Retainage receivable                       PROJECT_BACKLOG
  Inventory
  Prepaid expenses
= Current assets
  Property, plant & equipment, gross
  Less: accumulated depreciation
= Net PP&E
= TOTAL ASSETS

LIABILITIES
  Accounts payable
  Accrued liabilities
  Deferred revenue
  Current portion of long-term debt          principal due within 4 quarters
= Current liabilities
  Long-term debt
  Deferred tax liability
= TOTAL LIABILITIES

EQUITY
  Contributed capital
  Retained earnings
= TOTAL EQUITY
```

### 8.3 Cash flow statement (indirect method)

```
  Net income
+ Depreciation & amortization
- Δ Net working capital                      §5.2
= CASH FLOW FROM OPERATIONS

- Capital expenditures
+ Proceeds from asset disposals
= CASH FLOW FROM INVESTING

+ Debt drawdowns
- Debt principal repayments
- Debt origination fees
+ Owner capital contributions
- Owner distributions / draws
= CASH FLOW FROM FINANCING

= NET CHANGE IN CASH
```

### 8.4 Articulation assertions — hard failures

These run after **every** tick. They **throw**, they do not warn. If a player can ever export a model that does not tie, the credibility claim the entire product rests on is gone.

```ts
const TOLERANCE = 1n;  // 1 cent, to absorb rounding

assert(totalAssets === totalLiabilities + totalEquity);
assert(endingCash === beginningCash + cfo + cfi + cff);
assert(retainedEarnings_end === retainedEarnings_begin + netIncome - distributions);
assert(accumDep_end === accumDep_begin + depreciationExpense - accumDepOnDisposals);
assert(ppeGross_end === ppeGross_begin + capex - disposalsAtCost);
assert(debtOutstanding_end === debtOutstanding_begin + drawdowns - principalRepayments);
assert(every(business.cash >= 0n));           // must be resolved by §9.4 before tick completes
assert(inventory_end >= 0n && ar_end >= 0n);
assert(retainageReceivable_end >= 0n);
assert(deferredRevenue_end >= 0n);            // §5.3 renewal term exists to keep this true
assert(accumDep_end <= ppeGross_end - totalSalvageValue);

// Optional stream state — guard before asserting; only PROJECT_BACKLOG carries backlog
for (const s of streams)
  if (s.state.backlog !== undefined) assert(s.state.backlog >= 0n);
```

Any assertion failure is an engine bug. Fail loudly in development; in production, refuse to persist the period and surface an error rather than showing the player a broken model.

### 8.5 Derived metrics (computed, never LLM-generated)

Surface each quarter, per business and consolidated:

- Gross margin %, EBITDA margin %, net margin %
- **Peak cash need** and the period it occurs — headline output
- **Cash runway in quarters** at current burn
- Break-even revenue = `fixedAndStepCosts / grossMarginPct`
- Break-even occupancy (`OCCUPANCY`), break-even covers/day (`TRAFFIC`), break-even utilization (`UTILIZATION`)
- DSCR, current ratio, debt/EBITDA
- ROIC = `NOPAT / (net PP&E + net working capital)`
- Cash conversion cycle = `DSO + DIO - DPO`
- Owner's total economic return = draws + distributions + change in equity value
- **IRR on invested capital** across the full run

---

## 9. Turn Loop and Game Phases

### 9.1 Phase sequence

```
PHASE 0  SETUP
         Player picks starting capital: LOW ($100k) | MID ($1M) | FREEPLAY (custom, uncapped)

PHASE 1  CONCEPT INTERVIEW                    ← LLM contract: ConceptInterview
         Multi-turn conversation. LLM elicits: what the business does, location and
         market, buy vs. lease, scale, positioning, price point, staffing model,
         quality/cost tier. Ends when the LLM judges it has enough to synthesize.

PHASE 2  MODEL SYNTHESIS                      ← LLM contract: ModelSynthesis
         LLM emits a BusinessModel draft: archetype selection, stream params, cost
         lines, capex list, working capital policy, entity form. Engine validates
         against schema, injects omission-guard lines (§4.6), applies seed template
         defaults for anything unspecified, and builds the AssumptionRegister.

PHASE 3  ASSUMPTION REVIEW                    ← LLM contract: ChallengeAdjudication
         Player sees every assumption with value, range, provenance, and benchmark
         band. Out-of-band values are flagged by the engine. Player challenges any
         line; adjudication loop runs (§11.3). Loops until player commits.

PHASE 4  COMMIT
         Month-zero outlays hit cash (§5.4). Opening balance sheet is constructed.
         Financing is arranged. referencePrice locked for elasticity. Model frozen
         except through explicit in-game actions.

PHASE 5+ QUARTERLY OPERATE  (repeat)
         5a. Engine presents current state, statements, alerts, and available actions
         5b. Player submits actions (free text → ActionTranslation, or structured UI)
         5c. Engine validates actions; enqueues lead-time actions, applies immediate ones
         5d. Engine ticks in the exact order given in §9.2
         5e. Cash crisis resolution if needed (§9.4), then re-entry per §9.2 step 16
         5f. Assertions run (§8.4)
         5g. LLM narrates results                ← LLM contract: TurnNarration
         5h. Persist action log + snapshot

END OF PERIOD 39  MILESTONE
         Ten-year wrap: starting capital → ending net worth, IRR, the arc of the run,
         full statement history. Export offered. Play continues uninterrupted if the
         player wants to keep going — this is a milestone, not a terminus.
```

### 9.2 Tick order (must be exactly this)

Order matters; several of these have circular-looking dependencies that this sequence resolves.

```
 1. Advance period counter
 2. Mature pending actions whose lead time has elapsed (capacity/effect side)
 2a. Apply immediate-effect actions submitted this turn: SET_PRICE,
     SET_MARKETING_SPEND, DRAW_REVOLVER, INJECT_CAPITAL, DISTRIBUTE,
     REMOVE_STEP_BLOCK severance, and the COST side of ADD_STEP_BLOCK and
     PURCHASE_ASSET. (§9.3.1 — cost lands now, capacity lands later.)
 3. Apply lease escalators and contract expirations
 4. Compute UNCONSTRAINED demand per stream (§3)
 5. Compute blocksNeeded from demand (§4.3); apply blocksActive as the capacity
    constraint; derive realized volume and revenue
 6. Compute variable-with-revenue costs
 7. Compute activity drivers from REALIZED volume; compute variable-with-activity costs
 ┌── crisis re-entry point ──────────────────────────────────────────────┐
 8. Compute step-fixed costs from blocksActive; apply payroll load
 9. Compute fixed-period costs with escalators; apply payroll load
10. Compute depreciation on all assets
11. Compute interest on all debt; split payments into interest/principal
12. Compute pre-tax income
13. Apply NOL, compute tax (C_CORP: expense; pass-through: tax distribution, §7.1)
14. Compute net income
15. Household: draw living expenses, pay personal tax, receive distributions
16. Compute ending working-capital balances (§5.1) and ΔNWC (§5.2)
17. Assemble cash flow statement; compute ending cash
18. IF ending cash < 0 → resolve per crisisPolicy (§9.4), then RE-ENTER AT STEP 8
    (max 3 iterations; if still negative, insolvency)
 └──────────────────────────────────────────────────────────────────────┘
19. Roll balance sheet forward
20. Detect covenant breaches; detect step crossings, capacity constraints,
    lost-demand thresholds, runway warnings
21. Emit all EngineEvents (single emit point)
22. Run articulation assertions (§8.4)
```

**Two ordering rules that are easy to get wrong and expensive to discover late:**

**Crisis resolution must re-enter at step 8, not step 17.** Every remedy in §9.4 changes something computed earlier: a revolver draw or emergency loan changes interest (11) → pre-tax income (12) → tax (13) → net income (14); factoring reduces AR and books a financing expense (16); deferring owner comp removes a labor cost (9); a sale-leaseback creates a disposal gain and a new fixed-period cost (9, 10). Recomputing only the cash flow statement leaves the income statement and balance sheet stale, and step 22 will then fail — which is the good outcome. The bad outcome is silently disabling the assertion.

**Household outflows (15) precede the crisis check (18).** Otherwise a household capital injection can be granted against cash that living expenses and personal tax are about to consume, driving household cash negative with no resolution path left in the tick.

### 9.3 Action catalog

```ts
type Action =
  | { kind: 'SET_PRICE'; streamId: string; newPrice: Money }
  | { kind: 'SET_MARKETING_SPEND'; businessId: string; amountPerQuarter: Money }
  | { kind: 'ADD_STEP_BLOCK'; costId: string; blocks: number }
  | { kind: 'REMOVE_STEP_BLOCK'; costId: string; blocks: number }
  | { kind: 'PURCHASE_ASSET'; asset: FixedAssetSpec; financing: 'CASH' | 'DEBT'; debtSpec?: DebtSpec }
  | { kind: 'DISPOSE_ASSET'; assetId: string; salePrice: Money }
  | { kind: 'RAISE_DEBT'; spec: DebtSpec }
  | { kind: 'REPAY_DEBT'; debtId: string; amount: Money }
  | { kind: 'DRAW_REVOLVER'; debtId: string; amount: Money }
  | { kind: 'INJECT_CAPITAL'; businessId: string; amount: Money }   // household → business
  | { kind: 'DISTRIBUTE'; businessId: string; amount: Money }       // business → household
  | { kind: 'EXPAND_CAPACITY'; businessId: string; spec: CapacitySpec }
  | { kind: 'START_BUSINESS'; mode: 'FULL_INTERVIEW' | 'CLONE'; cloneFromId?: string }
  | { kind: 'DELEGATE'; businessId: string; managerCompPerQuarter: Money }
  | { kind: 'CLOSE_BUSINESS'; businessId: string }
  | { kind: 'SELL_BUSINESS'; businessId: string; multipleOfEbitda?: number }
  | { kind: 'RECLAIM'; businessId: string }                          // reverses DELEGATE, §9.6
  | { kind: 'CHANGE_ENTITY_FORM'; businessId: string; newForm: LegalForm }
  | { kind: 'SET_CRISIS_POLICY'; policy: CrisisRemedy[] }
  | { kind: 'ADJUST_ASSUMPTION'; assumptionId: string;
      newValue: number | Money; evidence?: string };
```

`SET_MARKETING_SPEND` carries a `streamId` (§3.0.5). `newValue` on `ADJUST_ASSUMPTION` must accept `Money` as well as `number`, since `Assumption.value` (§10.1) is a union of both.

### 9.3.1 Lead times and cost/effect asymmetry

| Action | Cost begins | Effect begins | Note |
|---|---|---|---|
| `SET_PRICE` | — | same quarter | |
| `SET_MARKETING_SPEND` | same quarter | same quarter | Ramped by response curve |
| `ADD_STEP_BLOCK` | **same quarter** | **+1 quarter** | You pay before you get capacity |
| `REMOVE_STEP_BLOCK` | severance same quarter | same quarter | |
| `PURCHASE_ASSET` | same quarter (cash out) | +1 quarter (depreciation, capacity) | |
| `EXPAND_CAPACITY` | spread over 2 quarters | +2 quarters | Buildout |
| `RAISE_DEBT` | fee same quarter | proceeds **+1 quarter** | Underwriting takes time |
| `START_BUSINESS` (full) | month-zero outlays at commit | +2 quarters to revenue | |
| `START_BUSINESS` (clone) | month-zero outlays at commit | +2 quarters to revenue | Reuses parent params |
| `DELEGATE` | +1 quarter | +1 quarter | |
| `CLOSE_BUSINESS` | +1 quarter | severance, lease termination penalty | |
| `SELL_BUSINESS` | +2 quarters | proceeds at close | |

The `ADD_STEP_BLOCK` asymmetry is deliberate and central. Hiring ahead of demand is how service businesses die, and the model must reproduce that.

### 9.4 Cash crisis resolution

Triggered at tick step 18 when ending cash < 0. **The engine never silently overdrafts.**

**Resolution must not break engine purity.** The tick is a pure function (§1.3) and replay determinism depends on it (§1.4), so the engine cannot pause mid-tick to ask the player anything. Instead the player maintains a **pre-declared `crisisPolicy`** — an ordered `CrisisRemedy[]` on `WorldConfig`, editable between turns via `SET_CRISIS_POLICY`. The engine applies remedies in that order until cash is non-negative or the list is exhausted.

After the tick, the orchestrator surfaces what was applied and offers the player a chance to revise the policy and re-run the quarter. That keeps the decision meaningful while keeping the engine deterministic.

Default policy, in order of least damage:

1. **Draw revolver**, if one exists with available capacity
2. **Household capital injection**, if household cash allows
3. **Factor receivables** — immediate cash at a 3–5% discount, recorded as a financing expense
4. **Defer owner compensation** — accrues as a liability, does not vanish
5. **Emergency debt** — available at prime + 12%, personal guarantee mandatory, 2% origination
6. **Sale-leaseback of equipment** — cash now, a new fixed-period lease cost forever
7. **Insolvency**

**Insolvency handling.** Not game over. The business enters `CLOSED`:

- Assets are liquidated at a haircut (equipment 35% of net book value, inventory 25%, real property 85%)
- Proceeds pay secured then unsecured creditors
- Any deficiency on personally guaranteed debt attaches to `Household` (§6.5) and sets `creditQuality = 'IMPAIRED'`
- Remaining businesses continue unaffected unless cross-guaranteed
- The player's capital loss is recorded and carried into the 10-year IRR

**Household insolvency.** If household cash goes negative at tick step 15 and no business can distribute, the household enters the same resolution ladder with a reduced option set: draw on personal debt capacity (HELOC/personal loan at prime + 6%, subject to `creditQuality`), take a distribution from any business with positive cash, or reduce `annualLivingExpenses` — floored at 60% of its starting value, because there is a limit to how much a founder can compress their life. If none suffice, the run enters `PERSONAL_INSOLVENCY`: `creditQuality` becomes `IMPAIRED`, all businesses with personal guarantees are forced into liquidation, and the narrator produces the same "what would have had to be true" post-mortem. This is the honest end state for a founder who over-committed personally, and the sim should be willing to reach it.

**Post-mortem is mandatory.** On insolvency, the narrator must produce a *"what would have had to be true"* analysis: the required average ticket, covers per day, occupancy, utilization, or win rate that would have made the business solvent, contrasted against what was modeled. For a prospective founder, this is the single most valuable output the product can generate — it converts a loss into a specific, checkable claim about the real world.

The same analysis should be available on demand at any time, not only at failure.

### 9.5 Starting additional businesses

Two paths, and offering both is what keeps the mid-game from becoming a chore:

**`FULL_INTERVIEW`** — the complete Phase 1–4 sequence for a genuinely new concept.

**`CLONE`** — copies an existing business's `BusinessModel` and re-prompts for only the parameters that differ: location, rent, addressable traffic, local wage rate, buildout cost, unit count. Everything else — cost structure, archetype params, working capital policy — carries over, with a `CLONED_FROM_PARENT` provenance tag. A second location should take two minutes, not twenty. Clones also get a small execution advantage reflecting operating experience:

```
clonedRampFloor = min(0.85, rampFloor + 0.10)
```

Expressed as a `min` against a ceiling above the highest seeded `rampFloor` (0.80 for an experienced `UTILIZATION` founder), so the bonus can never act as a penalty.

### 9.6 Delegation

`DELEGATE` installs a general manager. The business becomes `DELEGATED`:

- A `FIXED_PERIOD` labor cost is added at `managerCompPerQuarter`
- Step-fixed blocks **auto-scale** to meet `blocksNeeded` (the manager makes those calls)
- Marketing spend holds at its current level, escalating at `config.annualInflationPct`
- A **margin drift** representing the gap between owner attention and hired attention accumulates at a per-year rate set by manager quality, **capped** at a 4% total drag:

```
cumulativeDriftPct = min(0.04, driftRatePerYear * yearsDelegated)
driftRatePerYear: BUDGET 0.010 | STANDARD 0.005 | STRONG 0.002
```

- The player can no longer take operational actions on that business, but continues to receive distributions
- `RECLAIM` (§9.3) reverses this at the cost of one quarter of transition; `cumulativeDriftPct` decays back to zero over four quarters

Delegation is what makes a portfolio of eight businesses tractable in the late game without pretending management is free. Manager compensation quality should be a choice: a cheap manager has higher drift.

---

## 10. The Assumption Register

This is the product's differentiator. Build it first-class, not as an afterthought.

### 10.1 Structure

```ts
interface Assumption {
  id: string;
  businessId: string;
  path: string;                        // 'streams[0].params.avgTicket' — JSON pointer into the model
  label: string;                       // 'Average ticket'
  category: 'REVENUE' | 'COST' | 'CAPEX' | 'WORKING_CAPITAL' | 'FINANCING' | 'TAX';

  value: number | Money;
  unit: string;                        // 'USD' | 'pct' | 'count' | 'days' | 'hours'

  range: { low: number; high: number };   // defensible span for this input
  provenance: Provenance;
  sourceNote: string;                     // human-readable basis
  citation?: string;                      // URL or document reference if researched

  benchmarkBand?: { low: number; high: number; source: string };
  outsideBenchmark: boolean;              // engine-computed

  challengeHistory: ChallengeRecord[];
  lockedAtPeriod?: PeriodIndex;
  sensitivityRank?: number;               // engine-computed, see §12.3
}

type Provenance =
  | 'CATALOG'          // from the fixed cost catalog — authoritative
  | 'BENCHMARK'        // industry seed template median
  | 'PLAYER_SOURCED'   // player supplied a specific, checkable basis
  | 'PLAYER_ASSUMED'   // player asserted without evidence
  | 'LLM_ESTIMATE'     // model's judgment, no external basis
  | 'CLONED_FROM_PARENT';
```

### 10.2 Completeness invariant

> **Every numeric parameter that feeds the engine must have a corresponding `Assumption` record.**

Enforce this in `validateBusinessModel()`. If any parameter lacks a registered assumption, the model is invalid and cannot be committed. Without this rule the register decays into a partial log and the export loses its credibility claim.

### 10.3 The confidence hierarchy

Provenance is ordered: `CATALOG` > `PLAYER_SOURCED` > `BENCHMARK` > `LLM_ESTIMATE` > `PLAYER_ASSUMED`.

Note deliberately that **`PLAYER_ASSUMED` ranks lowest** — below the model's own estimate. An unsupported assertion by an optimistic founder is the least reliable input in the system, and the register should say so plainly. This is what stops the tool from becoming a machine for laundering wishful thinking into an official-looking spreadsheet.

Compute a **model confidence score**: the revenue-weighted share of assumptions at `PLAYER_SOURCED` or better. Display it prominently and include it in the export.

### 10.4 Provenance propagation to results

Every derived figure shown to the player must be traceable to its driving assumptions. Concretely: when the UI reports a change, it annotates with the driver and its tag.

> *"Revenue +6.2% — driven by your marketing response assumption ($47 CAC, tagged **player-assumed**)."*

This is the mitigation for having removed stochastic noise from the MVP. The player will otherwise read a deterministic output as a fact about the world rather than an echo of an input they chose twenty minutes earlier. Implement as a dependency graph from each statement line back to the assumption IDs that fed it.

### 10.5 Out-of-band detection

After synthesis and after every `ADJUST_ASSUMPTION`, the engine tests each assumption against its `benchmarkBand` and sets `outsideBenchmark`. Out-of-band assumptions are surfaced for review and become the trigger for cost-side pushback (§11.3.1). This check is **engine logic, not LLM judgment** — it's a numeric comparison and must be deterministic.

---

## 11. LLM Contracts

Five contracts. Each is a separate call with its own system prompt and a strict JSON output schema derived from the zod schemas in `packages/schemas`. Validate every response; on schema failure, retry once with the validation error appended, then fail to a structured error state rather than accepting malformed output.

**Universal constraints, restated in every system prompt:**

1. You do not compute totals, subtotals, or any figure that appears on a financial statement.
2. You emit assumptions and classifications only.
3. Every numeric assumption you emit must include a `range` and a `sourceNote`.
4. You never modify a locked assumption without going through the challenge contract.

### 11.1 `ConceptInterview`

**Purpose:** multi-turn conversation that elicits enough to build the model. Conversational output, plus a structured readiness signal.

**Must elicit, before signaling readiness:**

- What the business sells and to whom
- Location type and market (dense urban / suburban / rural; specific metro if known)
- Buy vs. lease; square footage or unit count
- Scale: seats, staff, units, crews
- Price point and positioning tier (value / mid / premium)
- Quality/cost tier on inputs
- Staffing model (owner-operated? full-time / part-time mix?)
- Hours and days of operation
- Whether the founder has relevant experience or an existing book of business
- Founder's available capital and appetite for debt

**Output schema:**

```json
{
  "reply": "string",
  "elicited": { "<field>": "<value or null>" },
  "readyToSynthesize": "boolean",
  "missingCriticalFields": ["string"]
}
```

**Behavioral rules.** Ask about **one** thing at a time; a wall of ten questions is how these conversations die. Offer concrete options rather than open prompts where possible ("most shops this size run 1,200–1,800 sq ft — does that sound right, or are you thinking bigger?"). Do not signal readiness with critical fields missing.

### 11.2 `ModelSynthesis`

**Purpose:** convert the interview into a structured `BusinessModel` draft. This is the highest-stakes call.

**Output schema (abridged; full zod schema in `packages/schemas/businessModel.ts`):**

```json
{
  "businessName": "string",
  "legalForm": "SOLE_PROP|LLC_PASSTHROUGH|S_CORP|C_CORP",
  "seedTemplateId": "string",
  "streams": [{
    "label": "string",
    "archetype": "TRAFFIC|UTILIZATION|UNITS_CAC|SUBSCRIPTION|OCCUPANCY|PROJECT_BACKLOG",
    "archetypeRationale": "string",
    "params": { "<paramName>": { "value": 0, "range": {"low":0,"high":0},
                                 "sourceNote": "string", "provenance": "..." } },
    "seasonality": [1.0, 1.0, 1.0, 1.0]
  }],
  "costLines": [{
    "label": "string",
    "class": "VARIABLE_REVENUE|VARIABLE_ACTIVITY|STEP_FIXED|FIXED_PERIOD",
    "params": { },
    "isLabor": "boolean",
    "accruable": "boolean",
    "sourceNote": "string",
    "provenance": "..."
  }],
  "capex": [{ "label": "string", "category": "...", "grossCost": 0,
              "usefulLifeYears": 0, "quantity": 0, "sourceNote": "string" }],
  "workingCapital": { "dsoDays": 0, "dioDays": 0, "dpoDays": 0, "...": 0 },
  "financingPlan": { "equityInjection": 0, "debtRequests": [] },
  "openNotes": ["string"]
}
```

**Rules:**

- Choose the archetype by binding constraint (§3.8), and state the rationale.
- Prefer seed template defaults; deviate only with a `sourceNote` explaining why this business differs.
- **Every** parameter needs `range` + `sourceNote` + `provenance`.
- Do not emit the omission-guard lines (§4.6) — the engine injects those. Emitting them causes duplicates.
- Seasonality must average 1.00 ± 0.01; the engine rejects otherwise.
- If the concept is unusual (the 256-flavor ice cream shop), do **not** refuse and do **not** flatter. Model it honestly: set `serviceComplexityFactor` from SKU count, raise `dioDays` for slow-turning inventory, raise spoilage, raise freezer capex and the square footage needed — and *also* raise `captureRate` and `marketingMultiplier.maxLift` for genuine novelty appeal. The output should be a business that is viable under some conditions and not others. **The player should learn what those conditions are, not be told yes or no.**

### 11.3 `ChallengeAdjudication` — the anti-sycophancy contract

**This is the most important prompt in the system.** The failure mode it exists to prevent: the player says *"I think that machine costs $10k, not $60k"* and the model replies *"Good point — $10k it is."* It would fold identically if the player had said $500. In a tool whose output someone may take to a lender, that behavior is not helpful; it is a defect.

**This call must be isolated from the conversational thread.** It receives only the assumption, its basis, the catalog/benchmark data, and the player's claim — never the rapport of an ongoing chat, which is what produces capitulation.

**Input:**

```json
{
  "assumption": { "label": "...", "value": 0, "range": {}, "sourceNote": "...",
                  "provenance": "...", "benchmarkBand": {} },
  "playerClaim": { "assertedValue": 0, "statedBasis": "string|null",
                   "evidenceUrl": "string|null" },
  "businessContext": { "archetype": "...", "scale": {}, "relevantParams": {} },
  "catalogEntry": { "priceRange": {}, "specTiers": [] }
}
```

**Output:**

```json
{
  "ruling": "CONCEDE|PARTIAL|DEFEND|NEED_CLARIFICATION",
  "newValue": "number|null",
  "newRange": "object|null",
  "newProvenance": "PLAYER_SOURCED|PLAYER_ASSUMED|CATALOG|null",
  "reasoning": "string",
  "clarifyingQuestion": "string|null",
  "specDiscriminator": "string|null"
}
```

**Adjudication rules, encoded in the system prompt:**

1. **Bare assertion is not evidence.** If `statedBasis` is null, you may move the value **at most to the nearer boundary of the existing `range`**, never outside it. Provenance becomes `PLAYER_ASSUMED`.
2. **Specific, checkable basis moves the value.** A model number, a listing, a quote, a spec, "new vs. used," a capacity rating. Provenance becomes `PLAYER_SOURCED` and the basis is recorded verbatim.
3. **When a claim is plausible but underspecified, ask a discriminating question.** This is usually the most valuable output. *"Batch freezers at $10k are 3-quart countertop units. At 400 covers a day you need 20-quart floor models, which run $18–25k used with no warranty, $45–60k new. Which are you pricing?"* Return `NEED_CLARIFICATION`.
4. **Defend when the player is wrong,** and say why, with the specific mechanism. Do not soften to preserve rapport.
5. **Concede fully and without hedging when the player is right.** Founders with domain experience frequently know more than the model does about their own industry. Do not defend a position you cannot support.
6. **Never accept a value that is physically or contractually impossible.** Zero rent on a leased space, 100% occupancy indefinitely, sub-minimum-wage labor, negative churn without an expansion mechanism. Return `DEFEND` with the constraint named.
7. **Check the second-order effect and say so.** If the player halves equipment cost, note that capacity, useful life, or maintenance cost likely moves too. A cheaper machine is usually a different machine.

**Retrieval, if available.** If the deployment has web access, run a search before adjudicating and cite the result. This dissolves most of the argument — the disagreement stops being the model's priors versus the player's priors and becomes a question about current listings. This is also the clearest reason to use the product instead of a plain chat window, and it should be prioritized right after MVP if not in it.

**Test this contract adversarially.** Ship with a fixture suite covering: correct player challenges (must concede), wrong player challenges (must defend), underspecified plausible claims (must ask), impossible claims (must refuse), and repeated pressure on the same assumption (must not drift — asserting three times in a row must not move the number further than asserting once). That last case is the sycophancy regression test and it should run in CI.

#### 11.3.1 Reverse challenge — the sim challenges the player

The same contract runs in reverse. When `outsideBenchmark` is set (§10.5), the sim initiates:

> *"Your labor is 44% of revenue. Median for full-service restaurants is 30–35%. What's driving that — higher wages than modeled, lower volume, or over-staffing?"*

Founders are usually most wrong on the cost side: understated labor, forgotten maintenance capex, no owner salary, missing insurance. Reverse challenge is where the register earns its keep as an active reviewer rather than a passive log.

### 11.4 `ActionTranslation`

**Purpose:** free text → structured `Action[]`. *"Let's bump marketing by $10k next quarter and hire another cook."*

**Output:**

```json
{
  "actions": [ { "kind": "...", "...": "..." } ],
  "unresolvable": ["string"],
  "confirmationSummary": "string"
}
```

**Rules.** Never invent an action not expressed by the player. If an amount is ambiguous ("bump marketing a bit"), place it in `unresolvable` and ask — do not guess. Always return `confirmationSummary` for the player to approve **before** the engine applies anything. Actions with cost/effect asymmetry must have that asymmetry stated in the summary: *"Adding a line cook: $16,800/quarter starting this quarter, capacity increases next quarter."*

A structured UI must exist alongside this. Natural language is the on-ramp, not the only road.

### 11.5 `TurnNarration`

**Purpose:** explain what happened. **Receives computed results; performs no arithmetic.**

**Input:** current and prior `StatementSet`, `EngineEvent[]`, derived metrics, and the assumption IDs driving the largest changes.

**Output:**

```json
{
  "headline": "string",
  "narrative": "string",
  "attributions": [{ "effect": "string", "assumptionId": "string", "provenance": "..." }],
  "warnings": ["string"],
  "suggestedQuestions": ["string"]
}
```

**Rules.** Lead with what changed and why. Every causal claim must map to an `EngineEvent` or a named assumption — no invented mechanisms. Do not restate numbers the UI already shows; explain them. Name the driving assumption and its provenance for any significant move (§10.4). Surface warnings the player has not seen: runway below 2 quarters, DSCR near covenant, lost demand above 15% of capacity, a step-fixed threshold approaching.

**Tone.** Direct and unsentimental. Not a cheerleader, not a doomsayer. The player is making a real decision with real money and deserves a straight read.

---

## 12. Export

The export is the commercial product. Design backward from it.

Format: `.xlsx` via `exceljs`. **Live formulas, not pasted values.** A model of hardcoded numbers is worthless to a founder — they need to change an assumption and watch it flow. Every statement cell must reference the Assumptions sheet.

### 12.1 Workbook structure

| # | Sheet | Contents |
|---|---|---|
| 1 | **Summary** | Business description, capital deployed, peak cash need and its month, break-even point, 5-year revenue/EBITDA/cash summary, model confidence score, disclaimer |
| 2 | **Assumptions** | The full register. One row per assumption: label, value, unit, range, provenance (color-coded), source note, citation, benchmark band, out-of-band flag. **Named ranges** so statements reference them by name, not by cell address |
| 3 | **Monthly Y1** | Three statements, monthly. Interpolated from quarterly using seasonality and ramp curves; state the interpolation method in a note |
| 4 | **Quarterly Y1–3** | Three statements, quarterly |
| 5 | **Annual Y1–10** | Three statements, annual |
| 6 | **Unit economics** | Archetype-appropriate: contribution margin per transaction, CAC payback, LTV/CAC, revenue per seat/unit/head, break-even volume |
| 7 | **Sensitivity** | Tornado chart on the top 10 assumptions by impact (§12.3) |
| 8 | **Scenarios** | Base / downside / upside, each as a switchable assumption column driven by a single toggle cell |
| 9 | **Debt schedule** | Per-loan amortization: beginning balance, payment, interest, principal, ending balance |
| 10 | **Capex & depreciation** | Per-asset schedule, replacement cycles, maintenance reserve |
| 11 | **Run history** | Every action taken, by quarter, with the resulting cash and equity position. The narrative record of the run |

### 12.2 Monthly interpolation for year one

The engine ticks quarterly, but founders and lenders expect month-by-month for year one. Interpolate, then **normalize so the three months sum exactly to the quarter** — otherwise sheet 3 will not reconcile to sheet 4, and a workbook whose own tabs disagree is worse than no workbook.

Requires a 12-element monthly weight vector on the seed template (`monthlySeasonalWeight[0..11]`, averaging 1.0), which is the monthly refinement of the quarterly `seasonality` tuple and must be consistent with it: each quarter's three weights must average to that quarter's seasonality value.

```
rawWeight[m]     = monthlySeasonalWeight[m] * maturityRamp(m/3, rampFloor, rampConstant)
normalized[m]    = rawWeight[m] / Σ(rawWeight over the 3 months of this quarter)
monthlyRevenue[m] = quarterRevenue * normalized[m]

assert(Σ monthlyRevenue over quarter === quarterRevenue)   // to the cent
```

Fixed costs divide evenly across the three months. Step-fixed costs land entirely in the month the block was added. Month-zero outlays (§5.4) appear in a separate pre-opening column, not inside month 1.

Label the sheet as interpolated. Do not present it as engine-computed precision — and note that "peak cash need and its **month**" (§12.1) is therefore an interpolated estimate, while the period-level figure from §5.4 is exact.

### 12.3 Sensitivity analysis

For each registered assumption, hold everything else constant and vary it across its `range`. Record the effect on (a) year-3 EBITDA and (b) peak cash need. Rank by absolute impact; write `sensitivityRank` back to the register.

Two things fall out of this that make it worth building properly:

- **The tornado chart tells the founder where to spend their research time.** If the model is dominated by one assumption tagged `PLAYER_ASSUMED`, that's the thing to go verify before signing a lease.
- **It rewards research without punishing optimism dishonestly.** A player who argues equipment down from $1.2M to $100k gets the lower number *and* sees that the model is now highly sensitive to it, with the point at which being wrong by 2× would exhaust their cash.

### 12.4 Required disclaimer

Present on the Summary sheet and in-app at export:

> This model is a projection built from stated assumptions, not a forecast or a guarantee. Its accuracy depends entirely on the accuracy of its inputs. Assumptions marked *player-assumed* or *LLM-estimate* have not been verified against external sources. This is not financial, legal, tax, or investment advice. Consult a qualified accountant before making capital commitments or presenting these figures to a lender or investor.

Additionally: if owner compensation was zeroed (§4.6), state that prominently on the Summary sheet — a model without owner comp is not comparable to a salary and must not be presented as if it were.

---

## 13. Testing Requirements

### 13.1 Articulation property tests — the non-negotiable

```
For each of the 6 archetypes:
  For 1,000 randomized parameter sets drawn from plausible ranges:
    Run 40 quarters with randomized but valid action sequences.
    Assert every invariant in §8.4 holds at every period.
```

Use `fast-check`. This suite is the foundation of the product's credibility claim and must be green before anything ships.

### 13.2 Golden-file tests

For each seed template, a fixed input set with a committed expected output for periods 0, 4, 12, 39. Any engine change that moves these numbers must be a deliberate, reviewed change. Catches silent regressions in tick ordering — which is where subtle breakage will actually come from.

### 13.3 Benchmark plausibility tests

A seeded full-service restaurant at default parameters must produce food cost 28–32%, labor 30–35%, EBITDA margin 8–15%. Same for every template. If the engine produces a restaurant with 60% EBITDA margins, the seeds or the engine are wrong and the tool is not credible.

### 13.4 LLM contract tests

- **Schema conformance rate** across a fixture set of 100 business descriptions; target > 99% after one retry.
- **Archetype classification accuracy** against a hand-labeled set of 100 descriptions; target > 90%.
- **Adjudication fixtures** (§11.3) — correct challenges conceded, incorrect defended, underspecified clarified, impossible refused.
- **Sycophancy regression:** assert that repeating an unsupported assertion three times does not move a value further than asserting once. Run in CI.

### 13.5 Economic sanity tests

- Raising price on an elastic stream must reduce volume and may raise or lower revenue — never raise both volume and price simultaneously.
- Increasing marketing spend must exhibit diminishing returns; the second $10k must buy less than the first.
- A business growing revenue 40% per year with `dsoDays = 60` and thin margins **must** hit a cash crisis. If it doesn't, working capital is wired wrong — this is the single most important behavioral test in the suite.
- Adding a step-fixed block must reduce margin in the quarter it is added and only later increase capacity.
- **Under-staffing trap regression (§4.3).** Seed a `TRAFFIC` business staffed well below demand, auto-add one block per quarter, and assert that realized transactions strictly increase until they reach the physical capacity ceiling. If `blocksNeeded` is wired to realized volume instead of demand, revenue freezes at the initial staffing ceiling permanently and this test fails. A 40-quarter reference run reproduced exactly that: revenue pinned at 4,000 transactions/quarter for ten years while true demand reached 11,600.
- **Payroll load component test.** Assert the stated defaults in §4.5 equal the sum of their components. A documented total its own parts cannot reproduce becomes a code bug the first time someone recomputes it.
- **Retainage cash drag.** A `PROJECT_BACKLOG` business growing 30%/yr with `retainagePct = 0.10` must show cumulative CFO materially below cumulative net income. This is the archetype's reason to exist; if it doesn't reproduce, the retainage rollforward is wrong.

### 13.6 Long-run stability

Run 200 quarters (50 years) across all archetypes. Assert: no overflow, no NaN, no unbounded compounding artifacts, assertions hold throughout. The player is allowed to keep playing past the milestone, so the engine must not degrade.

---

## 14. Build Sequence

Each milestone is independently demoable. Do not proceed until the prior milestone's tests are green.

**M1 — Engine skeleton** *(largest single chunk; do not shortcut it)*
Money type, `WorldState`, one archetype (`TRAFFIC`), the full cost engine, working capital, straight-line depreciation, one debt type, tax, three statements, all articulation assertions, quarterly tick. No LLM, no UI — a script that runs 40 quarters from a hardcoded model and prints statements that tie.

**M2 — Full archetype and cost coverage**
Remaining five archetypes. Seed templates (12+). Property tests across all archetypes. Benchmark plausibility tests. Still no LLM.

**M3 — LLM concept path**
`ConceptInterview` + `ModelSynthesis`. Schema validation and retry. Omission guard injection. `validateBusinessModel()`. Assumption register construction with the completeness invariant.

**M4 — Challenge loop**
`ChallengeAdjudication` with the full rule set. Reverse challenge from out-of-band detection. Adjudication fixture suite and the sycophancy regression test. Web retrieval if in scope.

**M5 — Turn loop and actions**
`ActionTranslation`, `TurnNarration`, full action catalog with lead times, cash crisis resolution, insolvency and post-mortem, event log. Structured action UI alongside natural language.

**M6 — Export**
Full workbook with live formulas and named ranges. Sensitivity analysis. Monthly interpolation. Scenarios.

**M7 — Multi-business and milestone**
`START_BUSINESS` (full + clone), `DELEGATE`, consolidation across businesses, household roll-up, 10-year wrap, continue-play mode.

---

## 15. Out of Scope for MVP

Explicitly deferred. Do not build; do not architect around them beyond leaving the seams clean.

- Competitors and competitive response
- Macroeconomic events, recessions, rate cycles, inflation shocks
- Random events of any kind — **the MVP is fully deterministic given assumptions**
- Stochastic demand or measurement noise (see §10.4 for the mitigation)
- Multiplayer, shared markets, player-to-player transactions
- Management attention as a scarce resource
- Labor market dynamics, turnover, wage inflation
- The remaining archetypes: marketplace, lending spread, agricultural yield
- Full deferred tax scheduling (§7.3 simplification stands)
- Multi-currency, international operations
- Coarse-grained fast-forward mode past year 10 — quarterly ticks continue indefinitely

Two of these are worth revisiting first once the MVP is real: **stochastic demand** (which is what makes the "experiment" framing literally true — you don't know your own CAC until you've spent into it several times) and **competitors** (which converts the export from a forecast into a scenario, a change with real product and positioning implications).

---

## 16. Open Questions for the Product Owner

1. **Web retrieval in MVP or not?** It substantially strengthens §11.3 and is the clearest differentiator against doing this in a plain chat window. It also adds latency, cost, and a failure mode. Recommendation: build the adjudication contract with a retrieval interface stubbed, ship MVP without it, enable immediately after.

2. **How much does the cost catalog need to be real?** §11.3 rule 1 depends on defensible ranges. A hand-built catalog of ~500 common line items with sourced ranges is a meaningful content investment but is also the thing that makes adjudication non-arbitrary. Decide early whether that is a build task or a data-licensing task.

3. **Does the player see the engine's formulas?** Showing them makes the tool more trustworthy and more educational; hiding them keeps the experience cleaner. Recommendation: hide by default, expose behind a "show the math" affordance on every derived figure. The audience for this product is disproportionately the kind of person who will want it.

4. **Free-play with uncapped starting capital breaks benchmark plausibility.** A player starting with $10B and opening a coffee shop produces a meaningless model. Either cap free-play, or scale scrutiny with the ratio of capital to business scale, or accept it as an explicitly unserious mode.

---

## Appendix A — Reference Implementation Check

Before this spec was finalized, §§3.1, 4, 5, 6, 7, 8 were implemented as a throwaway 200-line reference model and run for 40 quarters against a full-service restaurant. The purpose was to confirm the accounting actually articulates and the seed bands are reachable. Results:

**Articulation held at every period.** All assertions in §8.4 passed for all 40 quarters — balance sheet balanced to the cent, cash flow reconciled to the change in cash, retained earnings and accumulated depreciation rolled forward correctly. The structure in §8 is sound.

**The benchmark plausibility test (§13.3) caught a bad calibration immediately.** The first parameter set produced a restaurant with 74% labor cost and −77% EBITDA — obviously broken. It took three iterations to land in band. This is exactly the failure §13.3 exists to catch, and it will catch it again during seed-template authoring. Budget real time for calibration; the archetype math being correct does not make the seeds correct.

**Converged reference run** (64 seats, $42 ticket, 180k quarterly trade-area traffic, 5.0% capture):

| | Year 1 | Year 3 | Band (§13.3) |
|---|---|---|---|
| Revenue | $902k | $1,739k | — |
| EBITDA margin | −1.8% | 17.3% | 8–15% |
| Food cost | 30.0% | 30.0% | 28–32% ✓ |
| Labor | 38.1% | 32.6% | 30–35% ✓ |
| Rent | 11.5% | 6.3% | 6–10% ✓ |

Year-1 EBITDA slightly negative and year-3 above band, the latter because the reference model omitted several §4.6 omission-guard lines. Directionally correct: a restaurant that loses money in year one and matures into a solid operator.

**Two behaviors emerged from the mechanics rather than being designed in**, which is the good sign:

- The 3%/yr rent escalator compounded against a hard capacity ceiling and squeezed EBITDA back toward zero by year 10. A capacity-constrained business on an escalating lease gets slowly strangled — a real dynamic the sim reproduces without being told to.
- Seasonality plus the maturity ramp produced a realistic sawtooth in quarterly cash, with the Q1 trough being where a thin operator would actually fail.

**One ship-blocking defect was found and is now fixed in §4.3.** The original text made `blocksNeeded` a function of realized transactions. Because realized volume is itself capped by staffing, this created a self-reinforcing under-staffing trap: the reference run froze at 4,000 transactions per quarter for ten consecutive years while true demand climbed past 11,600. Nothing in the accounting was wrong — every assertion still passed — which is precisely why it would have shipped. Driving `blocksNeeded` from unconstrained demand resolved it on the first try.

The general lesson for whoever builds this: **articulation tests prove the books tie, not that the business logic is right.** Both suites in §13 are load-bearing.
