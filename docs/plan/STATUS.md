# Implementation status

Against the milestones in [02-milestones.md](./02-milestones.md).

| Milestone | State | Notes |
|---|---|---|
| **M0 — Scaffold** | ✅ Done | pnpm workspace, strict TS, `@bizsim/money`, zod schemas, pre-push verification, boundary enforcement, `sim` CLI |
| **M1 — Core engine (TRAFFIC)** | ✅ Done | Full tick, all four cost classes, working capital, tax, debt, three statements, 12 articulation assertions, crisis ladder, insolvency, provenance trace |
| **M2 — Archetypes + seeds** | 🟡 Mostly | All six archetypes property-tested at 1,000 cases each; 6 of 12+ templates calibrated and in band |
| **M3 — LLM concept path** | ⬜ Not started | `buildModelFromTemplate` is the engine-side seam the LLM replaces |
| **M4 — Challenge loop** | ⬜ Not started | |
| **M5 — Turn loop + actions** | 🟡 Partial | §9.1 Phases 0-5 playable via `pnpm sim --new`: capital choice, business design, assumption review, commit gate, quarterly operate. `START_BUSINESS`/`SELL_BUSINESS` deferred to M7 |
| **M6 — Export** | ⬜ Not started | |
| **M7 — Multi-business** | 🟡 Partial | Consolidation and household roll-up work; `DELEGATE`/`RECLAIM` implemented; clone not started |
| **M8 — Hardening + UI** | ⬜ Not started | No UI exists yet |

## M1 exit criteria

> `sim run` executes 40 quarters from a hardcoded model, prints three statements that tie to the cent at every
> period, and the four named tests are green. No LLM, no UI.

```
pnpm sim --scenario restaurant --periods 40 --print bands
```

All four gating tests are green:

| Test | Where |
|---|---|
| Articulation property suite, 1,000 cases × 40 quarters (§13.1) | `articulation.test.ts`, `archetypes.test.ts` |
| Under-staffing trap regression (§13.5) | `behaviour.test.ts` |
| Payroll load component test (§13.5) | `behaviour.test.ts` |
| Growth + DSO cash crisis (§13.5) | `behaviour.test.ts` |

106 tests. `pnpm check` runs typecheck, package boundaries and the suite in about four seconds;
`pnpm test:slow` runs §13.1 at its full 1,000 cases per archetype — 240,000 quarter-ticks — in about
ninety seconds.

**There is no hosted CI.** GitHub Actions is unavailable for this account, so `.github/workflows/ci.yml`
has had its automatic triggers removed — an always-red check trains people to ignore red, which is worse
than no check. The gate is a pre-push hook (`.githooks/pre-push`) running `pnpm check`, wired up by
`pnpm install`. Nothing downstream catches what it misses, which matters more here than usual: a run where
the books stop tying looks exactly like a run where they don't, until someone checks.

## M2 status

All six archetypes hold every §8.4 invariant across 1,000 randomized parameter sets × 40 quarters each.
Six templates are calibrated and land in band at maturity:

| Template | Archetype | Maturity | EBITDA margin | Band |
|---|---|---|---|---|
| Full-service restaurant | TRAFFIC | Y3 | 12.3% | 8–15% |
| Professional services firm | UTILIZATION | Y4 | 17.9% | 10–28% |
| Ecommerce / DTC brand | UNITS_CAC | Y5 | ~13% | 2–18% |
| B2B SaaS | SUBSCRIPTION | Y9 | −11.7% at Y8 | −15–30% |
| Self-storage facility | OCCUPANCY | Y6 | 28.8% | 18–45% |
| General contractor | PROJECT_BACKLOG | Y4 | 6.7% | 3–12% |

Two bands were widened from the initial guess, with the reason recorded in the template's own
`source` string rather than silently: self-storage because the published 60%+ figures are
property-level NOI and this line is full EBITDA after owner compensation, and SaaS because a
seed-stage company carrying a fixed engineering team is deeply negative for years by design.

Cost lines now come entirely from template data, so adding the remaining six templates is a JSON
change — which is what §4.7 asks for and what makes calibration, not authoring, the schedule risk.

Calibration is driven from the CLI, one scenario per archetype:

```
pnpm sim --scenario contractor --periods 40 --print bands
```

## Playing it

```
pnpm sim --new                                  # Phases 0-4, then play what you designed
pnpm sim --play --scenario contractor           # skip setup, play a seeded scenario
pnpm sim --scenario restaurant --print bands    # batch run, for calibration
```

`--new` covers §9.1 Phases 0 through 4: choose starting capital (LOW / MID / FREEPLAY),
choose what you are building, set the archetype's scale parameters against their benchmark
bands, arrange financing, then review every registered assumption with its provenance and
model confidence score before committing. Phase 4 is a real gate — a business that cannot
fund its own month zero is refused rather than opened with negative cash.

M3 replaces the *input method* for Phases 1-2, not the phases: the LLM turns "a taco place
in Austin" into the same archetype choice and parameters this asks for directly. Phases 0,
3 and 4 never needed a model at all.

## The reference run

The seeded full-service restaurant, against Appendix A's converged reference (64 seats, $42 ticket, 180k
quarterly trade-area traffic, 5.0% capture):

| | Y1 | Y3 | Band (§13.3) | Appendix A |
|---|---|---|---|---|
| Revenue | $1.1M | $1.8M | — | $902k / $1,739k |
| Food cost | 30.0% | 30.0% | 28–32% ✓ | 30.0% |
| Labor | 52.2% | 33.6% | 30–35% ✓ | 38.1% / 32.6% |
| EBITDA margin | −15.7% | 12.3% | 8–15% ✓ | −1.8% / 17.3% |

Year one runs hotter on labor than Appendix A's because this build carries the full §4.6 omission-guard set,
which the reference model omitted — the same reason its year three sat above band at 17.3%.

**Both emergent behaviours Appendix A describes reproduce without being designed in:**

- The 3%/yr rent escalator compounding against a hard capacity ceiling squeezes EBITDA from 12.6% in Y4 back to
  9.3% by Y10, as the occupancy line climbs 11.9% → 13.7%. A capacity-constrained business on an escalating
  lease gets slowly strangled. There is a test for it.
- Seasonality against the maturity ramp produces the sawtooth in quarterly cash, with the Q1 trough where a
  thin operator would actually fail.

## What is deliberately not built

- **Six more seed templates**, to reach the twelve §4.7 asks for: quick-service food, retail shop, coffee
  shop, marketing agency, trades contractor, gym/fitness studio.
- **Any LLM contract.** M1 and M2 are specified to ship without one, and they have.
- **The export.** See [D-4](./04-risks-and-decisions.md#d-4-the-export-is-a-second-engine-treat-it-as-one) — it
  is a second engine and needs the HyperFormula recalc harness from its first commit.
- **The UI.** The three-pane shell in [01-architecture.md §7](./01-architecture.md) is unstarted.
- **`START_BUSINESS` and `SELL_BUSINESS`** reject with an `ACTION_REJECTED` event rather than half-working.

## Simplifications taken, and where they are recorded

Each is commented at the point it applies:

| Simplification | Where |
|---|---|
| Deferred tax as one balance-sheet line, no full schedule (§7.3) | `tax.ts` |
| Origination fees expensed up front rather than amortised | `statements.ts` |
| Crisis remedies raise a 10% headroom rather than the exact shortfall | `tick.ts` |
| The in-state event log is a rolling 200-event window; persistence owns history | `tick.ts` |
| Runtime state is plain TS, not zod — only the trust boundaries are parsed | `state.ts` |

## Spec gaps

Eleven were found by reading ([03-spec-gaps.md](./03-spec-gaps.md) G-1 … G-11). Six more were found only by
running the engine (G-12 … G-17) — each produced a real articulation failure or a nonsensical run. The most
expensive was G-14: origination fees left cash with no offsetting entry and surfaced as a $500 balance-sheet
discrepancy a hundred periods after the loan that caused it.
