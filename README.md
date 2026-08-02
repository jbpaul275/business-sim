# Business Simulator

A conversational financial simulator for people considering starting a business. The user describes an idea,
works with an LLM to build a defensible financial model of it, then operates that business quarter by quarter
against a full three-statement model. Two things make it different from doing the same exercise in a chat
window:

1. **The numbers are computed by a deterministic engine, not by the LLM.** The model never drifts, always
   articulates, and runs 40+ periods without degradation.
2. **Every assumption carries provenance.** The export shows which inputs are researched, which are benchmark
   defaults, and which are the user's hopes.

Spec: [`docs/spec/business-sim-spec.md`](docs/spec/business-sim-spec.md).
Plan and current state: [`docs/plan/`](docs/plan/), starting with [STATUS.md](docs/plan/STATUS.md).

## Getting started

```sh
pnpm install          # also wires up the pre-push hook
pnpm check            # typecheck + package boundaries + tests  (~4s)
pnpm sim --scenario restaurant --periods 40 --print bands
```

Requires Node 22+ and pnpm 10+.

## Verifying changes

> **There is no hosted CI.** GitHub Actions is unavailable for this account, so nothing downstream will catch
> a regression. The gate is local and it is the only one.

`pnpm install` points `core.hooksPath` at [`.githooks/`](.githooks), which installs a **pre-push hook running
`pnpm check`**. If it fails, the push aborts. `SKIP_VERIFY=1 git push` bypasses it; prefer not to.

| Command | What it does | Time |
|---|---|---|
| `pnpm check` | typecheck, package boundaries, 106 tests | ~4s |
| `pnpm test:slow` | §13.1 at full strength — 6 archetypes × 1,000 parameter sets × 40 quarters | ~90s |
| `pnpm boundaries` | enforces that the engine stays pure and the LLM layer never reaches the ledger | <1s |
| `pnpm sim` | headless runner and seed-calibration harness | — |

Run `pnpm test:slow` before anything that touches the tick order, the cost engine or a seed template. It is
240,000 quarter-ticks and it is the suite the product's credibility claim actually rests on.

`.github/workflows/ci.yml` is retained as configuration but its automatic triggers are removed, so it will not
mark pull requests red. Restoring it is a two-line change, documented at the top of the file.

## Layout

```
packages/money      Money as integer cents (bigint). Zero dependencies.
packages/schemas    zod schemas → TS types → JSON Schema for the LLM contracts.
packages/engine     The deterministic engine. Pure: no randomness, no clock, no I/O.
packages/seeds      Seed templates as data, with benchmark bands and sources.
packages/sim-cli    Headless runner, calibration harness, golden-file generator.
```

The dependency rules in [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) are not style rules. Engine purity
(spec §1.3) and the rule that the LLM never computes a statement value (§1.1) are both claims about what code
can reach what, and `pnpm boundaries` is what makes them true rather than aspirational.

## The one thing to know before changing the engine

Spec §4.3: **`blocksNeeded` is driven by unconstrained demand, never by realized volume.** Realized volume is
already capped by staffing, so feeding it back as the staffing signal locks a business at its opening headcount
forever. The spec's own reference implementation shipped this backwards — revenue froze for ten simulated years
while true demand ran 3× higher — and every accounting assertion passed the whole time.

Articulation tests prove the books tie, not that the business logic is right. Both suites in §13 are
load-bearing.
