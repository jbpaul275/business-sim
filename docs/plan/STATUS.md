# Implementation status

Against the milestones in [02-milestones.md](./02-milestones.md).

| Milestone | State | Notes |
|---|---|---|
| **M0 — Scaffold** | ✅ Done | pnpm workspace, strict TS, `@bizsim/money`, zod schemas, CI, boundary enforcement, `sim` CLI |
| **M1 — Core engine (TRAFFIC)** | ✅ Done | Full tick, all four cost classes, working capital, tax, debt, three statements, 12 articulation assertions, crisis ladder, insolvency, provenance trace |
| **M2 — Archetypes + seeds** | 🟡 Partial | All six archetypes implemented; 1 of 12+ seed templates calibrated |
| **M3 — LLM concept path** | ⬜ Not started | `buildModelFromTemplate` is the engine-side seam the LLM replaces |
| **M4 — Challenge loop** | ⬜ Not started | |
| **M5 — Turn loop + actions** | 🟡 Partial | Full action catalog with lead times; crisis ladder and insolvency done. `START_BUSINESS`/`SELL_BUSINESS` deferred to M7 |
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
| Articulation property suite, 1,000 cases × 40 quarters (§13.1) | `articulation.test.ts` |
| Under-staffing trap regression (§13.5) | `behaviour.test.ts` |
| Payroll load component test (§13.5) | `behaviour.test.ts` |
| Growth + DSO cash crisis (§13.5) | `behaviour.test.ts` |

69 tests total. `pnpm check` runs typecheck, package boundaries and the suite.

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

- **Eleven seed templates.** The engine is archetype-complete; the templates are M2 content work and, per
  Appendix A, calibration — not authoring — is the schedule risk.
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
