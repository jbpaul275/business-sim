# Implementation status

Against the milestones in [02-milestones.md](./02-milestones.md).

| Milestone | State | Notes |
|---|---|---|
| **M0 — Scaffold** | ✅ Done | pnpm workspace, strict TS, `@bizsim/money`, zod schemas, pre-push verification, boundary enforcement, `sim` CLI |
| **M1 — Core engine (TRAFFIC)** | ✅ Done | Full tick, all four cost classes, working capital, tax, debt, three statements, 12 articulation assertions, crisis ladder, insolvency, provenance trace |
| **M2 — Archetypes + seeds** | ✅ Done | All six archetypes property-tested at 1,000 cases each; all 12 §4.7 templates calibrated and in band |
| **M3 — LLM concept path** | 🟡 Mostly | `packages/llm` interviews, drafts and maps into `buildModelFromTemplate`; wired into `pnpm sim --new`. Governed by [D-5](./04-risks-and-decisions.md#d-5--the-absurdity-principle--the-ai-pushes-back-on-impossibility-never-on-implausibility). No live-call test yet |
| **M4 — Challenge loop** | 🟡 Mostly | The §11.3 contract, isolated from the thread, with rules 1 and 6 enforced in code rather than requested. Adversarial fixtures and the sycophancy regression are in the suite. `ADJUST_ASSUMPTION` now writes through to the model, which it never did. Reverse challenge (§11.3.1) fires on out-of-band assumptions. Cost catalog at 146 items with word-boundary keyword routing — labor, equipment, licences, services and COGS bands across the played business types. Authored ranges, not retrieved ones (below) |
| **M5 — Turn loop + actions** | 🟡 Mostly | §9.1 Phases 0-5 playable via `pnpm sim --new`. The §9.4 post-mortem is in, mandatory on insolvency and available any time. A model answers questions mid-game against a briefing it cannot see past, with every money figure in its reply checked back against the ledger (§11.4). `TurnNarration` (§11.5) narrates every pause — headline, narrative and suggested questions over the engine's screen, money-guarded like the advisor, silent when it cannot pass the guard — and now carries `attributions`, engine-computed (§10.4, below). `START_BUSINESS`/`SELL_BUSINESS` deferred to M7 |
| **M6 — Export** | ⬜ Not started | |
| **M7 — Multi-business** | ✅ Done | `START_BUSINESS` CLONE with §9.5's ramp bonus and two-quarter lead; `SELL_BUSINESS` at a trailing-EBITDA multiple; `DELEGATE`/`RECLAIM`; consolidation and household roll-up; ten-year wrap with the passive benchmark; continue-play past the milestone. `FULL_INTERVIEW` re-enters setup and is not a tick action |
| **M8 — Hardening + UI** | 🟡 In progress | `apps/web` — the three-pane shell from [01 §7](./01-architecture.md): turn log with §10.4 attributions and provenance badges · statements (IS/BS/CF to the cent) with a metric-tile strip · assumption register with provenance colour coding and deviation labels · structured action bar (price, marketing, hire/fire, run/skip). **Phases 0–4 run in the browser**: capital → the concept conversation (repair rounds, undo, transient recovery) → the drafted concept card → the worked funding plan with live loan quotes → the register review with the §11.3 challenge (adjudicated, written through, provenance updated in place) → structural objections re-entering the interview → commit into a playable session carrying the setup journal. In-game, every register row takes `assume` with optional evidence, applied as `ADJUST_ASSUMPTION` next tick. The CLI and web share one adjudication core (`argue.ts`) and one funding arithmetic (`funding.ts`), so the two frontends cannot quote different plans. Sessions run server-side; the client renders strings and never recomputes a financial (§1.1, applied to the browser). Not yet: advisor chat pane and narration in web, "show the math", free-text `ActionTranslation`, crisis policy editor, debt/capex controls, session persistence |

**Cross-cutting, added since the milestone plan was written:**

| | State | Notes |
|---|---|---|
| **Provider routing** | ✅ Done | `OpenAICompatibleTransport` over a `VENDORS` table — Moonshot, DeepSeek, Groq, Together, OpenRouter, Gemini, OpenAI — plus Anthropic on its own. Kimi K3 is the default for every call — K2.6 took the turns for half a day and failed its live gate (double-encoding, garble-twice, 23-60s latencies). [05](./05-provider-migration.md) |
| **Per-call telemetry** | ✅ Done | One journal row per model call: type, provider, model, effort, wall clock, four token counts, cost. `--sessions` reports a head-to-head by model on cost, latency and three quality signals |
| **Telemetry upload** | 🟡 Built, unwired | Supabase schema, two-tier opt-in, insert-only RLS, redaction with tests. Migrations never applied; the ambient metrics opt-in has no signup screen yet. [06](./06-telemetry-upload.md) |
| **Per-session QA share** | ✅ Done | The third consent surface: "share this run with QA?" at the end of a run — CLI prompt and web panel — forcing the transcript tier for that one explicitly-approved session regardless of ambient opt-out, with an optional note to a `feedback` table and a reference id as the deletion handle. Journals now carry replay-grade `actions` events (content-classified), so a shared run reproduces deterministically. [06 §5](./06-telemetry-upload.md) |
| **Delta attribution (§10.4)** | ✅ Done | `attributeQuarter` decomposes each significant quarter-over-quarter statement-line move into named drivers — seasonality, ramp, marketing, price, base, capacity ceiling, per cost line — each mapped to its registered assumption and provenance tag. Demand factors are pure in (stream, period), so last quarter's are recomputed exactly from last quarter's state; cost classes are re-evaluated at both endpoints through the engine's own cost functions; driver amounts are normalised to sum exactly to the line's true delta, with an explicit remainder. Printed deterministically every turn (no model required), fed to `TurnNarration` as the only legal mechanisms, journalled per quarter. This is also the machinery M8's provenance-annotated deltas need |

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
All twelve §4.7 templates are calibrated and land in band at maturity:

| Template | Archetype | Maturity | EBITDA margin | Band |
|---|---|---|---|---|
| Full-service restaurant | TRAFFIC | Y3 | 12.3% | 8–15% |
| Professional services firm | UTILIZATION | Y4 | 17.9% | 10–28% |
| Ecommerce / DTC brand | UNITS_CAC | Y5 | ~13% | 2–18% |
| B2B SaaS | SUBSCRIPTION | Y9 | −11.7% at Y8 | −15–30% |
| Self-storage facility | OCCUPANCY | Y6 | 28.8% | 18–45% |
| General contractor | PROJECT_BACKLOG | Y4 | 6.7% | 3–12% |
| Quick-service restaurant | TRAFFIC | Y3 | 17.1% | 10–20% |
| Coffee shop | TRAFFIC | Y3 | 16.4% | 6–17% |
| Retail shop | TRAFFIC | Y3 | 10.7% | 4–12% |
| Marketing agency | UTILIZATION | Y4 | 13.3% | 8–20% |
| Trades contractor | PROJECT_BACKLOG | Y4 | 16.2% | 8–18% |
| Gym / fitness studio | SUBSCRIPTION | Y5 | 15.6% | 10–25% |

The second six reuse archetypes the first six proved, so each was authored as JSON and calibrated
from the CLI — which is what §4.7 predicted authoring-as-data would buy. The two that fought back:
the trades contractor opened capacity-bound (flat revenue at its own execution ceiling — the fix was
headroom, not margin), and the gym is a SUBSCRIPTION business whose first draft ramped like a SaaS,
burning $2.2M of rent before members stabilised. The calibrated gym front-loads acquisition
(presale-style ramp floor), churns at a realistic 13%/quarter, and prices at $55/month — the
CAC-drip toward steady state is exactly the dynamic that kills real gyms, and the template now
survives it with a peak cash need of $1.6M against $2.0M raised.

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

- **The rest of the cost catalog, and its verification.** 146 items of D-2's ~500 — the trades, equipment,
  licences and rate bands the played business types actually hit. Two honest caveats. Coverage accretes:
  until an item exists, rule 1 still clamps against the draft's own estimated range. And the ranges are
  *authored* — written from 2024-era price knowledge with wide bands and tiers, checkable source
  descriptions, and deliberately generous edges, but not retrieved from live listings. These ranges overrule
  players, so `PriceRetrieval` (§16 Q1) is not just a feature deferral: it is the upgrade path from
  "a well-argued range" to "three current listings", and the catalog's numbers should be treated as the
  former until it lands.
- **Retrieval (§16 Q1).** `PriceRetrieval` is defined and unimplemented. With web access the argument stops
  being the model's priors against the player's and becomes a question about current listings.
- **Assumption trajectories.** Learning curves — a recruiting network dropping from 25 interviews per
  placement toward 5 as it compounds — have no engine primitive: costs cannot improve as a function of
  cumulative volume. Half-deliberate (nothing may move without a visible assumption), and today the player
  enacts the curve through `assume` revisions the eigen questions prompt. If it lands, it lands as
  scheduled, register-visible revisions — never a hidden curve.
- **The founder profile.** Specced, not built — [07](./07-founder-profile.md). The load-bearing-inputs
  law ("never collect what the model won't carry"), one new must-ask person-question (domain
  experience), and four effect mappings, every one a visible register line: ramp floor from years in
  the trade, the owner-supplied labor block (the deferred owner-2-blocks item, declared in the
  player's own words rather than picked from a persona menu), the lender's file pricing experience,
  and expertise-as-evidence in the challenge loop (one tier, in domain only, never past D-5). Four
  shippable stages; persona pickers and the industry multi-select deliberately deferred.
- **A duplicate-overheads guard beyond known families.** A live draft carried "Accounting & legal" AND
  "Accounting, legal, and compliance" at $2,500 each — omission-guard defaults beside custom lines saying
  the same thing, paying twice. `duplicateOverheadIssues` now catches the known families (accounting,
  software, insurance, permits, utilities, owner comp) deterministically and feeds the repair loop; a
  generic near-duplicate check (same statement line, overlapping label tokens) would catch pairs the
  family list does not name.
- **Any LLM contract.** M1 and M2 are specified to ship without one, and they have.
- **The export.** See [D-4](./04-risks-and-decisions.md#d-4-the-export-is-a-second-engine-treat-it-as-one) — it
  is a second engine and needs the HyperFormula recalc harness from its first commit.
- **The rest of the web UI.** The shell, the interview, the challenge flow and the turn loop are in.
  The turn loop is data-then-one-question: each quarter the advisor pane posts §11.5 narration (LLM,
  fails soft to silence) and ONE deterministic eigen question — `selectAxis` in `sim-cli/eigen.ts`
  picks the axis by hierarchy (crisis → biggest §10.4 driver → looming constraint → idle slack) with
  a two-quarter repetition memory, and the chat answers through the same briefing/money-guard the
  CLI uses, with suggested commands parsed into stageable action-bar moves. §11.4 `ActionTranslation`
  is folded into the same advise call: an instruction in chat ("raise the price to $6.50, hire another
  crew") comes back as `orderedCommands` in the game's own syntax — validated by the same parser as
  suggestions, staged only when the player confirms from the summary, with anything ambiguous or
  inexpressible listed as unresolvable rather than guessed at. Narration resolves the player's bet:
  the moves that actually queued (described server-side from the accepted actions) and the eigen
  question they answered ride the §11.5 input, and the prompt opens the quarter on that bet's verdict —
  a read on the outcome, never a judgement of the decision, and never invented when no moves were
  staged. The funding screen prices depth (Dave-the-Diver rule: chosen, visible, priced): three named
  plans — Lean, Proposed, Cushioned — each just an equity preset over the same `fund` lever, wearing a
  deterministic gauge from `planDepth`/`depthGauge` (`sim-cli/depth.ts`): the candidate world ticked 12
  quarters silently, first crisis-ladder touch and cash trough reported at plan AND with demand 30%
  under it (one stress lever per archetype), debt service at its heaviest, and the downside stated
  before the dive — the personally-guaranteed principal that follows you home. The action bar is a
  staged strip: price and marketing stay tactile, everything else stages as chips (typed into the
  command input — the game's own grammar parsed deterministically by the suggestion validator, `?` for
  the clickable template menu that keeps the strategy space visible — or clicked from advisor chips and
  confirm cards, or from hire/cut links beside the staffing table), and the strip above Run states the
  bet the next quarter's narration resolves. The morebar's eight form pairs and the hire steppers are
  deleted. Watch across play-tests: action diversity, command-input usage, time-to-run. The register is tabbed by
  what each number bears on — investment (capex, working-capital terms, financing), P&L (prices, rates,
  recurring amounts), descriptive (square feet, seats, hours) — with the category clusters and the
  escalator column inside each tab, classified deterministically from `category`/`unit`/`isMoney`.
  Still CLI-or-nothing: "show the math" and the crisis policy editor; the CLI's own turn loop does not
  yet use `selectAxis`, and its advisor does not yet surface `orderedCommands`.
- **`START_BUSINESS` in `FULL_INTERVIEW` mode.** A brand-new concept needs the Phase 1-4 conversation, which
  cannot run inside a pure tick. CLONE covers the case §9.5 says should take two minutes; a genuinely
  different second business is a new run today.
- **A clone re-prompting for each parameter that differs.** §9.5 lists location, rent, traffic, wage rate,
  buildout and unit count; this build takes one size multiplier covering all of them.
- **Live calls in `pnpm check`.** Deliberately never. What exists instead: `pnpm smoke`
  (`sim-cli/smoke.ts`) drives one real session against the configured provider — an interview turn, the
  forced draft (the staged per-stage grammars where the transport supports them, one-shot otherwise), one
  production-style repair round, then the deterministic tail to `buildCandidate` and zero validation
  errors. Run on demand with a key exported; it fails fast naming the missing key var otherwise. This is
  the check that would have caught the live failures to date before a player did (the oversized draft
  grammar, the 0.975 seasonality, the monthly cadence). First live pass 2026-08-05 on kimi-k3: turn plus
  all four staged grammars accepted on the wire, zero repair rounds, zero validation errors — 5 calls,
  52.9k in / 2.6k out, $0.07, 76s. It needs re-running whenever the provider, a prompt, or a wire schema
  changes — nothing runs it automatically, and the Anthropic transport still falls back to the one-shot
  draft (`draftStage` unimplemented).
- **One real session on the meter.** Partially answered by the smoke's first pass: a real session-shaped
  run on kimi-k3 cost $0.07 (52.9k in / 2.6k out), consistent with the published-rate arithmetic the
  provider switch was decided on. A full played run — turns, advisor chat, adjudications over forty
  quarters — is still unmeasured; play-test sessions with journals are where that number will come from.

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
