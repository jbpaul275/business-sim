# Business Simulator — Implementation Plan

Planning documents for the MVP described in `docs/spec/business-sim-spec.md` (v1.0).

| Doc | Contents |
|---|---|
| [STATUS.md](./STATUS.md) | What is built, what is not, and how the reference run compares to Appendix A |
| [01-architecture.md](./01-architecture.md) | Monorepo layout, package boundaries, numeric conventions, purity enforcement |
| [02-milestones.md](./02-milestones.md) | M0–M8 breakdown: tasks, exit criteria, sizing, parallel tracks |
| [03-spec-gaps.md](./03-spec-gaps.md) | Ambiguities and defects in the spec that need a decision before the affected code is written |
| [04-risks-and-decisions.md](./04-risks-and-decisions.md) | Risk register, answers to the spec's §16 open questions, performance budgets |
| [05-provider-migration.md](./05-provider-migration.md) | Moving the four LLM calls off Anthropic onto Kimi: model mapping, what breaks, and the gate a provider passes before it becomes the default |

---

## TL;DR

**Shape of the work.** Roughly 25 engineer-weeks for one senior engineer; ~12 calendar weeks with three
people working the tracks in [§Parallel tracks](./02-milestones.md#parallel-tracks). The spec's own build
sequence (§14) is sound and this plan follows it, with three changes:

1. **A new M0** (scaffold, money type, CI, schema conventions) pulled out of M1. M1 as written in the spec is
   "the largest single chunk"; a chunk that large with no tooling underneath it is where schedules go to die.
2. **M6 (Export) is re-sized from a milestone to a project.** The spec asks for a workbook of *live formulas*
   that recompute from the Assumptions sheet. That is a second implementation of the engine, written in Excel
   formula language, which must agree with the TypeScript engine to the cent. See
   [Decision D-4](./04-risks-and-decisions.md#d-4-the-export-is-a-second-engine-treat-it-as-one) — the
   mitigation is a headless recalc test in CI, and it needs to exist from the first export commit, not the last.
3. **A UI track added throughout.** The spec specifies the UI in one ASCII box (§1.2) and nowhere else. It is
   the least-specified and second-largest surface in the product.

**Highest-risk items,** in order:

| Risk | Why | Mitigation |
|---|---|---|
| Seed-template calibration | Appendix A: three iterations to get *one* template in band. There are 12+. | Budget 2 weeks of pure calibration in M2; build the calibration harness (`sim-cli`) in M0, not M2 |
| Export/engine divergence | Two implementations of the same arithmetic | HyperFormula recalc diff in CI from day one of M6 |
| Assumption→statement dependency graph (§10.4) | Retrofitting provenance tracing onto a finished engine is a rewrite | Thread `AssumptionId[]` through computation from the first tick in M1 |
| Adjudication sycophancy (§11.3) | Model behavior, not code; can regress on any provider/model change | Fixture suite + CI regression gate, pinned model version |

**The one thing to get right first.** §4.3: `blocksNeeded` is driven by *unconstrained demand*, never by
realized volume. The spec's own reference implementation shipped this bug and every accounting assertion still
passed. Write the regression test in M1 alongside the code, not after.

---

## Sequencing at a glance

```
M0  Scaffold ......................  0.5w   ── tooling, Money, CI, sim-cli harness
M1  Core engine (TRAFFIC) .......... 4.0w   ── ledger, statements, assertions, tick
M2  Archetypes + seeds ............. 4.0w   ── 5 archetypes, 12 templates, calibration
M3  LLM concept path ............... 2.5w   ── interview, synthesis, register
M4  Challenge loop ................. 2.0w   ── adjudication, reverse challenge, anti-sycophancy
M5  Turn loop + actions ............ 3.5w   ── action catalog, crisis ladder, insolvency
M6  Export ......................... 4.0w   ── formula workbook, sensitivity, monthly interp
M7  Multi-business + milestone ..... 2.0w   ── clone, delegate, consolidation, 10y wrap
M8  Hardening + UI polish .......... 2.5w   ── show-the-math, perf, long-run stability
                                    ─────
                                    25.0w
```

Every milestone is independently demoable and gated on the prior milestone's tests being green — as the spec
requires. Detail in [02-milestones.md](./02-milestones.md).
