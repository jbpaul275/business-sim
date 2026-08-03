# Implementation status

Against the milestones in [02-milestones.md](./02-milestones.md).

| Milestone | State | Notes |
|---|---|---|
| **M0 — Scaffold** | ✅ Done | pnpm workspace, strict TS, `@bizsim/money`, zod schemas, pre-push verification, boundary enforcement, `sim` CLI |
| **M1 — Core engine (TRAFFIC)** | ✅ Done | Full tick, all four cost classes, working capital, tax, debt, three statements, 12 articulation assertions, crisis ladder, insolvency, provenance trace |
| **M2 — Archetypes + seeds** | 🟡 Mostly | All six archetypes property-tested at 1,000 cases each; 6 of 12+ templates calibrated and in band |
| **M3 — LLM concept path** | 🟡 Mostly | `packages/llm` interviews, drafts and maps into `buildModelFromTemplate`; wired into `pnpm sim --new`. Governed by [D-5](./04-risks-and-decisions.md#d-5--the-absurdity-principle--the-ai-pushes-back-on-impossibility-never-on-implausibility). No live-call test yet |
| **M4 — Challenge loop** | 🟡 Mostly | The §11.3 contract, isolated from the thread, with rules 1 and 6 enforced in code rather than requested. Adversarial fixtures and the sycophancy regression are in the suite. `ADJUST_ASSUMPTION` now writes through to the model, which it never did. Reverse challenge (§11.3.1) fires on out-of-band assumptions. Cost catalog is a first tranche (16 items), not D-2's ~500 |
| **M5 — Turn loop + actions** | 🟡 Mostly | §9.1 Phases 0-5 playable via `pnpm sim --new`. The §9.4 post-mortem is in, mandatory on insolvency and available any time. A model answers questions mid-game against a briefing it cannot see past, with every money figure in its reply checked back against the ledger (§11.4). `TurnNarration` not started; `START_BUSINESS`/`SELL_BUSINESS` deferred to M7 |
| **M6 — Export** | ⬜ Not started | |
| **M7 — Multi-business** | ✅ Done | `START_BUSINESS` CLONE with §9.5's ramp bonus and two-quarter lead; `SELL_BUSINESS` at a trailing-EBITDA multiple; `DELEGATE`/`RECLAIM`; consolidation and household roll-up; ten-year wrap with the passive benchmark; continue-play past the milestone. `FULL_INTERVIEW` re-enters setup and is not a tick action |
| **M8 — Hardening + UI** | ⬜ Not started | No UI exists yet |

**Cross-cutting, added since the milestone plan was written:**

| | State | Notes |
|---|---|---|
| **Provider routing** | ✅ Done | `OpenAICompatibleTransport` over a `VENDORS` table — Moonshot, DeepSeek, Groq, Together, OpenRouter, Gemini, OpenAI — plus Anthropic on its own. Kimi K3 is the default. [05](./05-provider-migration.md) |
| **Per-call telemetry** | ✅ Done | One journal row per model call: type, provider, model, effort, wall clock, four token counts, cost. `--sessions` reports a head-to-head by model on cost, latency and three quality signals |
| **Telemetry upload** | 🟡 Built, unwired | Supabase schema, two-tier opt-in, insert-only RLS, redaction with tests. Migration never applied; no in-game consent screen; no retention or deletion path. [06](./06-telemetry-upload.md) |

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

## The absurdity principle, demonstrated

[D-5](./04-risks-and-decisions.md#d-5--the-absurdity-principle--the-ai-pushes-back-on-impossibility-never-on-implausibility)
says the system pushes back on physical and contractual impossibility and on nothing else. §11.2's
256-flavour ice cream shop is the test case, and `packages/engine/src/absurdity.test.ts` runs it as its own
template — own cost lines, own capex, `plausibility: {}` — rather than bolting flavours onto the restaurant.

All four configurations are the same concept. Only the conditions differ:

| 256-flavour shop | Counter | Ticket | Capture | Y6 EBITDA margin |
|---|---|---|---|---|
| Plain shop's price and draw | 30 positions | $9 | 5.0% | −8.7% |
| Priced and marketed for novelty | 30 positions | $13 | 8.5% | −1.8% |
| Same, counter built for the queue | 40 positions | $13 | 8.5% | **+14.4%** |
| *Control:* 40 flavours, same everything | 40 positions | $13 | 8.5% | +25.5% |

The condition the run surfaces is the useful part: pricing for novelty is not enough on its own, because the
shop is turning people away at the counter and no ticket price fixes that. 256 flavours needs about a third
more counter than 40 does to serve the same queue — the throughput haircut is 21%, and it is charged in
seconds per order, in 22 dipping cabinets instead of 4, and in inventory days that rise from 21 to 35. Give
it enough counter that neither shop is capacity-bound and the gap closes to under 5 points, which is the
honest answer: the complexity bites at the counter, not on the P&L.

Nothing in the run flags out-of-band, because a 256-flavour shop has no published operating benchmark and
the template claims none. The §10.3 confidence score reports 0.23 instead — roughly a fifth of the 53
registered assumptions are sourced at `PLAYER_SOURCED` or better. Uncertainty is reported, not hidden.

**Benchmarks are weak constraints, and the line the engine does hold is physical.** An absent band means
"nobody knows," not "any number goes." Two mechanisms carry that, both green:

- `Assumption.benchmarkDeviation` measures a miss in band-widths rather than flagging it, so the register
  can distinguish a rent 1.1× its range from a ticket price 17× its range — and sorts by magnitude, so the
  startling one is seen first. `deviationLabel()` renders it the way a founder reads it.
- `floorAreaSqFt` is required on the seat-turns capacity model, and `CAPACITY_EXCEEDS_FOOTPRINT` refuses a
  seat count that will not physically fit at the building-code minimum. This is what makes "there is no
  billion-dollar single-location ice cream shop" arithmetic rather than taste: revenue is servable customers
  × price, and something has to bound the customers. `EXPAND_CAPACITY` is bounded by the same rule, so the
  gate cannot be bought around one buildout at a time — but taking more floor area, and the rent with it, is
  always allowed.

## Playing it

```
pnpm sim --new                                  # Phases 0-4, then play what you designed
pnpm sim --play --scenario contractor           # skip setup, play a seeded scenario
pnpm sim --scenario restaurant --print bands    # batch run, for calibration
```

`--new` covers §9.1 Phases 0 through 4. **Phases 1-2 are now a conversation**: describe a
business in a sentence and the interview asks what it needs, estimates the rest, and emits a
draft. Phase 3 still reviews every registered assumption with its provenance and model
confidence; Phase 4 is still a real gate — a business that cannot fund its own month zero is
refused rather than opened with negative cash.

The model behind that conversation is **Kimi K3** — `export MOONSHOT_API_KEY=...` and nothing
else. Anthropic remains a supported provider and is used when only `ANTHROPIC_API_KEY` is set;
`BIZSIM_LLM_PROVIDER` forces one either way. The reasoning is cost: see
[05-provider-migration.md](./05-provider-migration.md), which also records the two things this
switch has *not* yet been through — a real session on the meter, and a live call proving
Moonshot accepts the request the transport builds. Every LLM path here is still verified
against stubs.

With neither key set, setup says so and falls back to the template picker. The picker is what
you get when there is no model to talk to, not a co-equal alternative.

What the conversation replaces is the *input method*, not the phases. A drafted concept
becomes a **synthetic seed template** and goes through `buildModelFromTemplate` like any
other, so the omission guard, assumption registration, validation and the property suite all
apply unchanged — and a novel concept carries `plausibility: {}` and no benchmark bands,
which is D-5 expressed in the data rather than in a prompt.

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
- **The rest of the cost catalog.** D-2 scopes ~500 items across twelve templates; sixteen are in, chosen to
  give the adjudication contract real ranges and real tiers to argue from. The mechanism is done and the
  content accretes — but until an item is in the catalog, rule 1 clamps against the draft's own estimated
  range, which is a weaker claim than the rule is meant to make.
- **Retrieval (§16 Q1).** `PriceRetrieval` is defined and unimplemented. With web access the argument stops
  being the model's priors against the player's and becomes a question about current listings.
- **Any LLM contract.** M1 and M2 are specified to ship without one, and they have.
- **The export.** See [D-4](./04-risks-and-decisions.md#d-4-the-export-is-a-second-engine-treat-it-as-one) — it
  is a second engine and needs the HyperFormula recalc harness from its first commit.
- **The UI.** The three-pane shell in [01-architecture.md §7](./01-architecture.md) is unstarted.
- **`START_BUSINESS` in `FULL_INTERVIEW` mode.** A brand-new concept needs the Phase 1-4 conversation, which
  cannot run inside a pure tick. CLONE covers the case §9.5 says should take two minutes; a genuinely
  different second business is a new run today.
- **A clone re-prompting for each parameter that differs.** §9.5 lists location, rent, traffic, wage rate,
  buildout and unit count; this build takes one size multiplier covering all of them.
- **`TurnNarration` (§11.5).** The quarterly screen is still engine output with no prose over it. A model
  now answers questions mid-game (§11.4), but it does not narrate the result of a quarter.
- **Any live-call test, anywhere.** Every LLM path in this repo is verified against scripted or stubbed
  transports. Nothing has ever asserted that a real provider accepts the request a transport builds. That
  was a tolerable gap while there was one provider that had visibly worked; it is the largest unverified
  surface in the build now that the default provider changed on the strength of stubs alone.
- **One real session on the meter.** Every `spend` record in `.bizsim/` is a test fixture with zero tokens.
  The cost case for the provider switch is entirely arithmetic on published rates.

## Simplifications taken, and where they are recorded

Each is commented at the point it applies:

| Simplification | Where |
|---|---|
| Deferred tax as one balance-sheet line, no full schedule (§7.3) | `tax.ts` |
| Origination fees expensed up front rather than amortised | `statements.ts` |
| Crisis remedies raise a 10% headroom rather than the exact shortfall | `tick.ts` |
| The in-state event log is a rolling 200-event window; persistence owns history | `tick.ts` |
| Runtime state is plain TS, not zod — only the trust boundaries are parsed | `state.ts` |
| The funding-gap projection runs 8 quarters, not the full 40 | `plausibility.ts` |

## Spec gaps

Eleven were found by reading ([03-spec-gaps.md](./03-spec-gaps.md) G-1 … G-11). Six more were found only by
running the engine (G-12 … G-17) — each produced a real articulation failure or a nonsensical run. The most
expensive was G-14: origination fees left cash with no offsetting entry and surfaced as a $500 balance-sheet
discrepancy a hundred periods after the loan that caused it.
