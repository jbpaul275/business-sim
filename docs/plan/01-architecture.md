# Architecture

Concretising §1 of the spec into a buildable repository.

---

## 1. Repository layout

```
business-sim/
├── pnpm-workspace.yaml
├── tsconfig.base.json               # strict: true, noUncheckedIndexedAccess: true
├── vitest.workspace.ts
├── packages/
│   ├── money/                       # Money (bigint cents), mulRate, rounding. ZERO deps.
│   ├── schemas/                     # zod schemas → inferred TS types → JSON Schema for LLM
│   ├── engine/                      # pure tick(). deps: money, schemas ONLY.
│   ├── seeds/                       # 12+ seed templates as JSON + loader + band validation
│   ├── llm/                         # 5 contracts, provider adapter, validate+retry
│   ├── export/                       # exceljs workbook + formula emitter
│   └── sim-cli/                     # headless runner, calibration harness, golden-file gen
├── apps/
│   └── web/                         # Next.js App Router
└── fixtures/
    ├── golden/                      # per-template expected output at periods 0, 4, 12, 39
    ├── adjudication/                # §11.3 challenge fixtures incl. sycophancy cases
    └── descriptions/                # 100 hand-labelled business descriptions (§13.4)
```

### Dependency rule

```
money   ← engine ← export
schemas ← engine ← sim-cli
schemas ← llm                    (llm NEVER imports engine)
seeds   ← engine
engine, llm, export, seeds ← apps/web
```

`packages/engine` importing anything outside `money`, `schemas`, `seeds` is a build failure. Enforce with
`dependency-cruiser` in CI — the purity claim in §1.3 is the product's credibility claim, and "we'll be
careful" is not an enforcement mechanism. A single accidental `import { openai }` inside the engine
invalidates every determinism guarantee the spec makes.

The `llm` package not importing `engine` matters for a different reason: it is what physically prevents an
LLM contract from being handed a ledger to compute against. The hard rule in §1.1 becomes a lint rule.

---

## 2. Numeric conventions

The spec is precise about money and silent about everything else. Both need a rule, because the two mix in
almost every formula (`revenue = transactions * avgTicket` multiplies a float by a bigint).

| Kind | Type | Examples |
|---|---|---|
| Currency | `Money = bigint` (integer cents) | prices, costs, balances, every statement line |
| Quantity | `number` (float) | transactions, customers, subscribers, hours, units, blocks |
| Rate / ratio | `number` (float) | percentages, elasticities, occupancy, multipliers |
| Period | `number` (integer) | `PeriodIndex` |

**The single conversion rule:** a float becomes money only through `mulRate(m: Money, r: number): Money`.
There is no other path. `revenue = mulRate(avgTicket, transactions)`. This centralises rounding
(half-away-from-zero, per §2.7) in one tested function and makes "where did the cent go" answerable.

Quantities are deliberately *not* rounded — 4,183.7 transactions is a meaningful expected value in a
deterministic model, and rounding it to 4,184 introduces a per-period error that compounds across 40 periods.
Round only at the money boundary.

**Fractional blocks are the exception.** `StepFixedCost.currentBlocks` and `blocksNeeded` are integers by
construction (`ceil`, per §4.3) — you cannot hire 0.4 of a cook, which is the entire point of the class.
Type them as branded `Integer` or assert integrality in the constructor.

---

## 3. Engine surface

```ts
// packages/engine/src/index.ts — the entire public API
export function tick(
  state: WorldState,
  actions: Action[],
): TickResult;

export interface TickResult {
  state: WorldState;            // new object; input is never mutated
  statements: StatementSet;
  assertions: AssertionResult[];
  events: EngineEvent[];
  trace: ComputationTrace;      // §5 below
}

export function replay(genesis: WorldState, log: ActionLog): TickResult[];
export function validateBusinessModel(m: BusinessModel): ValidationResult;
export function openingBalanceSheet(m: BusinessModel, cfg: WorldConfig): WorldState;
```

Everything else — cost resolution, working capital, tax, the crisis ladder — is internal. Keeping the surface
this small is what makes the engine replaceable and the replay guarantee (§1.4) enforceable.

`tick` is a pure function. No `Date.now()`, no `Math.random()`, no I/O. Add an ESLint `no-restricted-globals`
rule for `Date` and `Math.random` scoped to `packages/engine` so this is mechanically true rather than
aspirationally true.

### Tick internals

Implement §9.2's 22 steps as 22 named functions in one ordered pipeline, not as a 900-line function. The
crisis re-entry loop (steps 8→18, max 3 iterations) then becomes a literal `for` loop over a slice of the
pipeline, which is the only way that control flow stays readable:

```ts
const preCrisis  = [advancePeriod, maturePending, applyImmediate, applyEscalators,
                    computeDemand, resolveCapacity, variableRevenueCosts, activityCosts];
const crisisLoop = [stepFixedCosts, fixedPeriodCosts, depreciation, interest, pretaxIncome,
                    tax, netIncome, householdFlows, workingCapital, cashFlowStatement];
const postCrisis = [rollBalanceSheet, detectEvents, emitEvents, runAssertions];
```

Name the array indices to constants so "re-enter at step 8" is expressed in code rather than in a comment
that will drift.

---

## 4. Event sourcing and persistence

Per §1.4, the action log is truth and snapshots are cache.

```sql
create table worlds        (id uuid pk, player_id uuid, config jsonb, engine_version text,
                            created_at timestamptz);
create table actions       (world_id uuid, seq int, period int, action jsonb,
                            submitted_at timestamptz, primary key (world_id, seq));
create table snapshots     (world_id uuid, period int, state jsonb, statements jsonb,
                            primary key (world_id, period));
create table assumptions   (world_id uuid, business_id text, assumption_id text, record jsonb,
                            primary key (world_id, business_id, assumption_id));
create table llm_calls     (id uuid pk, world_id uuid, contract text, request jsonb,
                            response jsonb, model text, valid boolean, retry_count int);
```

`engine_version` on `worlds` is load-bearing. When the engine changes, old worlds either replay to a
different result (correct, and the migration path the spec wants) or must be pinned. Recording the version at
genesis is what makes that a choice rather than a discovery.

`llm_calls` exists for the evaluation suites in §13.4. Contract accuracy targets ("archetype classification
> 90%") cannot be measured without a corpus of real calls.

**Snapshot integrity check:** in CI, and behind a debug flag in production, replay the action log from genesis
and assert the resulting state equals the stored snapshot. This is the only test that actually proves the
event-sourcing claim; without it the log is decorative.

---

## 5. Provenance tracing (§10.4) — decide this in M1, not M6

> "Implement as a dependency graph from each statement line back to the assumption IDs that fed it."

This is one sentence in the spec and it is a cross-cutting concern touching every computation in the engine.
Retrofitting it after the engine is finished means editing every formula. It goes in M1.

The cheap approach that works: every intermediate value carries the set of assumption IDs that produced it.

```ts
type Traced<T> = { value: T; deps: ReadonlySet<AssumptionId> };
```

Rejected — wrapping every number kills readability and performance across 40-period × 1,000-case property
tests.

**Recommended instead:** a period-scoped collector threaded through the tick context.

```ts
interface TickContext {
  readonly assumptions: AssumptionRegister;
  trace: {
    read(id: AssumptionId): void;             // called by the accessor, not by formula code
    scope<T>(line: StatementLineId, fn: () => T): T;  // attributes all reads inside fn to line
  };
}
```

Formula code reads assumptions through `ctx.get('streams[0].params.avgTicket')` rather than reaching into the
model directly. The accessor records the read; `scope` attributes reads to whichever statement line is being
computed. Cost: one indirection per parameter read. Benefit: §10.4 falls out for free, and the sensitivity
analysis in §12.3 gets a free pruning signal (an assumption no statement line reads cannot affect output, so
skip its sensitivity run).

The same mechanism satisfies the "show the math" affordance in §16 Q3 at near-zero marginal cost.

---

## 6. Schemas as the single source of truth

`packages/schemas` defines everything in zod; TypeScript types are inferred, and JSON Schema for the LLM
contracts is derived from the same objects via `zod-to-json-schema`. Three consumers, one definition.

```ts
export const AvgTicket = money().describe('Average transaction value');
export const TrafficParams = z.object({ ... });
export const BusinessModel = z.object({ ... });
export const ModelSynthesisOutput = z.object({ ... });   // → JSON Schema for structured output
```

Money in JSON is the one wrinkle: `bigint` does not survive `JSON.stringify`, and JSON Schema has no bigint.
Serialise money as a **string of integer cents** (`"10000000"` = $100,000.00) with a zod transform on both
sides. Not a number — `Number.MAX_SAFE_INTEGER` is only ~$90 trillion in cents, which is fine for this domain,
but float round-tripping through JSON is exactly the class of bug the bigint decision exists to prevent, and
the FREEPLAY mode (§16 Q4) has no capital cap.

**LLM contracts never emit `Money` in bigint form** — they emit the string, or a plain decimal that the zod
transform converts. Reject any LLM numeric that fails integral-cents parsing rather than coercing it.

---

## 7. UI structure

The spec gives the UI one ASCII diagram. Filling that gap:

```
┌──────────────┬───────────────────────────┬──────────────────┐
│  Chat        │  Statements               │  Assumptions     │
│  (interview, │  IS / BS / CF tabs        │  register, with  │
│   narration, │  + derived metrics strip  │  provenance      │
│   actions)   │  + event/alert feed       │  colour coding   │
│              │                           │  + challenge     │
├──────────────┴───────────────────────────┴──────────────────┤
│  Action bar: structured controls (price, marketing, hire,    │
│  capex, financing) + free-text box → ActionTranslation       │
└──────────────────────────────────────────────────────────────┘
```

Three non-obvious UI requirements that fall out of the spec and should be treated as functional, not polish:

1. **Every derived figure needs a "show the math" affordance** (§16 Q3, recommendation: hide by default,
   expose on demand). The §5 trace makes this a data-availability problem rather than an engineering one.
2. **`ActionTranslation` output must be confirmed before application** (§11.4) — the confirmation summary is a
   modal step in the turn loop, not a toast.
3. **The crisis policy editor** (§9.4). The player pre-declares an ordered `CrisisRemedy[]`; after a tick that
   consumed remedies, the orchestrator offers a re-run. This is a real screen with real state, not a settings
   toggle, and it is easy to miss when reading §9.4 quickly.

Render statements server-side from the persisted snapshot. The client never recomputes financials — the same
rule as §1.1, applied to the browser.
