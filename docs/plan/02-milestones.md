# Milestones

Sizing is engineer-weeks for one senior engineer. Each milestone is independently demoable and gated: **do not
start the next until the current milestone's tests are green** (§14).

---

## M0 — Scaffold · 0.5w

Pulled out of the spec's M1. The spec calls M1 "the largest single chunk; do not shortcut it" — starting it
without tooling underneath guarantees it gets shortcut.

- pnpm workspace, `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- `packages/money`: `Money`, `add`, `sub`, `mulRate`, `pct`, `toDisplay`, `fromDisplay`, `sum`, `min`, `max`.
  Property tests for rounding: half-away-from-zero, sign symmetry, `mulRate(m, 1) === m`, no drift over
  10,000 chained operations
- `packages/schemas`: zod conventions, the money-as-string codec (§6 of architecture doc), JSON Schema derivation
- CI: typecheck, lint, test, `dependency-cruiser` boundary check
- `packages/sim-cli` skeleton: `sim run <model.json> --periods 40 --print statements`

**Exit:** `pnpm test` green; CI fails on an engine→llm import; money property tests pass.

**Why sim-cli this early:** it is the calibration harness for M2 and the golden-file generator for M1. Two
weeks of seed calibration without a headless runner is two weeks of clicking.

---

## M1 — Core engine, TRAFFIC only · 4.0w

The spec's M1. The whole product's credibility sits here.

**M1a — Ledger and statements (1.5w)**
- `WorldState`, `Business`, `Household`, `BusinessBalances` as zod schemas
- Cost engine: all four cost classes (§4.1–4.4), payroll load (§4.5)
- Straight-line depreciation (§2.5), one debt type (`AMORTIZING`, §6.1)
- Tax: one entity form to start (`LLC_PASSTHROUGH`), NOL carryforward (§7.2)
- IS / BS / CF assembly (§8.1–8.3) — **including the disposal gain/loss line the spec omits**
  ([gap G-7](./03-spec-gaps.md#g-7-no-income-statement-line-for-disposal-gains-or-factoring-discount))
- All 12 articulation assertions (§8.4), throwing, running after every tick

**M1b — TRAFFIC and the tick loop (1.5w)**
- Shared modifiers: `maturityRamp`, `marketingMultiplier`, `priceEffect` with the ratio clamp (§3.0)
- `TrafficParams` tick incl. `serviceComplexityFactor`, peak concentration, capacity binding (§3.1)
- Step-fixed resolution with **`blocksNeeded` from unconstrained demand** (§4.3)
- The 22-step tick pipeline (§9.2) with the crisis re-entry loop wired but remedies stubbed
- Working capital: AR/inventory/AP, ΔNWC (§5.1–5.2), month-zero outlays and peak cash need (§5.4)

**M1c — Trace and harness (1.0w)**
- Assumption accessor + trace collector (architecture §5) threaded through every parameter read
- `AssumptionRegister` construction; completeness invariant in `validateBusinessModel()` (§10.2)
- Golden-file capture at periods 0, 4, 12, 39
- Replay-equals-snapshot integrity test

**Tests that must exist by end of M1 (not deferred to M2):**
- Articulation property test, TRAFFIC only, 1,000 cases × 40 periods (§13.1)
- **Under-staffing trap regression (§13.5).** Seed a TRAFFIC business staffed below demand, auto-add one block
  per quarter, assert realized transactions strictly increase to the physical ceiling. This is the defect the
  spec's own reference implementation shipped with every assertion still passing
- Payroll load component test (§13.5): stated defaults equal the sum of their parts
- Growth-plus-DSO cash crisis test (§13.5): 40%/yr growth, `dsoDays = 60`, thin margin → must run out of cash

**Exit:** `sim run` executes 40 quarters from a hardcoded restaurant model, prints three statements that tie to
the cent at every period, and the four tests above are green. No LLM, no UI.

---

## M2 — Full archetype and cost coverage · 4.0w

**Archetypes (1.5w).** UTILIZATION, UNITS_CAC, SUBSCRIPTION, OCCUPANCY, PROJECT_BACKLOG (§3.2–3.6).
PROJECT_BACKLOG is the expensive one — retainage schedule, per-stream DSO override, backlog rollforward, and
it is the only archetype that adds a balance-sheet line.

**Seed templates (0.5w build, 2.0w calibration).** 12 templates as JSON with benchmark bands and source notes
(§4.7). **The calibration is the schedule risk, not the authoring.** Appendix A records three iterations to
land one template in band; assume similar per template and parallelise with the sim-cli harness.

- Full-service restaurant · quick-service food · retail shop · coffee shop · professional services ·
  marketing agency · trades contractor · general contractor · ecommerce/DTC · SaaS · gym/fitness · self-storage
- Each must pass §13.3 benchmark plausibility before it counts as done

Treat templates as **content with an owner**, not code. A domain-literate person (ideally with operator
experience) reviewing the bands is worth more than another engineer here.

**Tests:** articulation property tests extended to all six archetypes (§13.1); benchmark plausibility per
template (§13.3); economic sanity suite (§13.5) including the retainage cash-drag test; long-run stability at
200 quarters (§13.6).

**Exit:** all 12 templates in band; six archetypes green under property tests; still no LLM.

---

## M3 — LLM concept path · 2.5w

- Provider adapter with JSON-schema-constrained generation; validate → retry once with the error appended →
  structured error state (§11)
- `ConceptInterview` (§11.1): multi-turn, one question at a time, readiness signal
- `ModelSynthesis` (§11.2): the highest-stakes call
- Omission-guard injection (§4.6) — engine-side, and the LLM prompt must forbid emitting these lines
- `validateBusinessModel()` enforcing the completeness invariant (§10.2)
- Out-of-band detection (§10.5) — deterministic numeric comparison, engine-side
- Minimal UI: chat pane + assumption register pane, enough to run Phases 1–3

**Tests (§13.4):** schema conformance > 99% after one retry across 100 fixture descriptions; archetype
classification accuracy > 90% against the hand-labelled set. Build the 100-description corpus during M2 so it
is ready when M3 starts — it is annotation work, not engineering work, and it blocks the exit criteria.

**Exit:** a natural-language business description produces a schema-valid, register-complete `BusinessModel`
that the M1/M2 engine can run for 40 quarters.

---

## M4 — Challenge loop · 2.0w

The anti-sycophancy contract (§11.3). Small in code, high in iteration.

- `ChallengeAdjudication`, **isolated from the conversational thread** — this call gets the assumption, the
  benchmark, and the claim, and nothing else. The isolation is the mechanism; rapport is what produces capitulation
- The seven adjudication rules encoded in the system prompt
- Reverse challenge from `outsideBenchmark` (§11.3.1)
- `ChallengeRecord` history on each assumption; provenance transitions
- Retrieval interface **stubbed but defined** (§16 Q1) — ship MVP without, enable straight after
- Cost catalog: see [Decision D-2](./04-risks-and-decisions.md#d-2-cost-catalog-scope). Rule 1 ("bare
  assertion moves the value at most to the nearer boundary of the existing range") depends on ranges existing,
  so the catalog is a prerequisite, not an enhancement

**Tests:** the adversarial fixture suite — correct challenges conceded, wrong challenges defended,
underspecified claims clarified, impossible claims refused. **The sycophancy regression runs in CI**: asserting
three times must not move a value further than asserting once.

**Exit:** fixture suite green; sycophancy regression in CI; a player arguing a $60k freezer down to $10k gets
the discriminating question from §11.3 rule 3, not a capitulation.

---

## M5 — Turn loop and actions · 3.5w

- Full action catalog (§9.3) with lead times and cost/effect asymmetry (§9.3.1)
- `ScheduledAction` queue; the ADD_STEP_BLOCK asymmetry (cost now, capacity next quarter)
- Underwriting gate (§6.3) incl. the pre-revenue collateral path; covenants (§6.4); personal guarantee (§6.5)
- Cash crisis ladder (§9.4): all seven remedies, applied in pre-declared policy order, re-entering the tick at
  step 8. Max 3 iterations
- Insolvency: liquidation haircuts, creditor waterfall, guarantee attachment, `creditQuality` impairment
- Household insolvency with the reduced remedy set and the 60% living-expense floor
- **Mandatory post-mortem** ("what would have had to be true"), available on demand at any time, not only at failure
- `ActionTranslation` (§11.4) + confirmation step; `TurnNarration` (§11.5)
- Structured action UI alongside the free-text box — natural language is the on-ramp, not the only road

**Exit:** a full 40-quarter game is playable end to end. Every crisis remedy exercised by a test that then
re-runs all §8.4 assertions — the crisis path is where stale income statements hide.

---

## M6 — Export · 4.0w

**Larger than it reads.** See [D-4](./04-risks-and-decisions.md#d-4-the-export-is-a-second-engine-treat-it-as-one).

- Formula emitter: statement cells reference named ranges on the Assumptions sheet, never literals
- **HyperFormula recalc diff in CI from the first commit of this milestone**: emit the workbook, recalculate it
  headlessly, diff every cell against the engine's own output at every period, to the cent. Without this test
  the workbook silently disagrees with the product that generated it
- 11 sheets (§12.1)
- Monthly Y1 interpolation with exact per-quarter normalisation (§12.2), labelled as interpolated
- Sensitivity: vary each assumption across its range, record effect on Y3 EBITDA and peak cash need, rank,
  write `sensitivityRank` back to the register, emit tornado chart (§12.3)
- Scenarios: base/downside/upside driven by one toggle cell
- Disclaimer (§12.4) + the zeroed-owner-comp warning

**Exit:** a founder can open the workbook, change an assumption, and watch every statement move — and the
recalc diff proves the workbook and the engine agree.

---

## M7 — Multi-business and milestone · 2.0w

- `START_BUSINESS` full interview and CLONE (§9.5) with the `min(0.85, rampFloor + 0.10)` clone bonus and
  `CLONED_FROM_PARENT` provenance
- `DELEGATE` / `RECLAIM` (§9.6): manager cost, auto-scaling blocks, capped margin drift, four-quarter decay
- Consolidation across businesses; household roll-up
- Ten-year wrap at end of period 39: starting capital → ending net worth, IRR, the arc of the run
- Continue-play past the milestone

**Exit:** an eight-business portfolio runs 40 quarters with consolidated statements that tie.

---

## M8 — Hardening and UI · 2.5w

- "Show the math" affordance on every derived figure (§16 Q3) — cheap, given the M1 trace
- Provenance annotation on every reported delta (§10.4): *"Revenue +6.2% — driven by your $47 CAC assumption,
  tagged player-assumed"*
- Performance: see [budgets](./04-risks-and-decisions.md#performance-budgets)
- 200-quarter stability across all archetypes (§13.6): no NaN, no overflow, no compounding artifacts
- Accessibility, error states, LLM-failure fallbacks, export progress for large workbooks

---

## Parallel tracks

With three people, ~12 calendar weeks instead of ~25:

| Track | Owns | Path |
|---|---|---|
| **Engine** | money, schemas, engine, sim-cli | M0 → M1 → M2 → M5 → M7 |
| **Content + LLM** | seeds, cost catalog, fixtures, llm | corpus + catalog during M1 → M2 calibration → M3 → M4 |
| **Export + UI** | export, apps/web | UI shell during M1 → M3 UI → M6 → M8 |

The Export/UI track is idle-ish during M0–M2 and should spend it on the UI shell and the formula-emitter spike
— proving a single sheet of live formulas round-trips through HyperFormula before M6 depends on it removes the
largest unknown in the plan.

The Content track's work (12 calibrated templates, a ~500-item cost catalog, 100 labelled descriptions,
adjudication fixtures) is the least parallelisable and the easiest to under-budget. It starts in week 1.
