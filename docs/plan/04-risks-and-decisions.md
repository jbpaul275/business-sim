# Risks, decisions, and budgets

---

## Answers to the spec's §16 open questions

### D-1 · Web retrieval in MVP?

**Agree with the spec: build the interface, ship without it, enable immediately after.**

The reasoning in §16 is right — retrieval is the clearest differentiator against doing this in a chat window,
and it converts adjudication from "my priors vs. your priors" into "here are three current listings." But it
adds latency to the single most latency-sensitive interaction (a player arguing with the model in real time),
plus a failure mode, plus per-call cost.

The thing that makes deferral safe is defining `RetrievalProvider` in M4 and having `ChallengeAdjudication`
call it through that interface with a null implementation. Adding retrieval afterwards is then a provider swap,
not a prompt rewrite. Do **not** ship M4 with retrieval-shaped assumptions baked into the prompt text.

### D-2 · Cost catalog scope

**It is a build task, and it is the prerequisite for M4, not an enhancement to it.**

§11.3 rule 1 — "bare assertion moves the value at most to the nearer boundary of the existing `range`" —
is mechanically dependent on a defensible range existing. Without a catalog, every range is an
`LLM_ESTIMATE`, and the adjudication contract is arbitrating between two guesses while presenting the result
as authoritative. That is the exact behaviour the contract exists to prevent, one level up.

**Recommendation:** ~500 hand-built items with sourced ranges, scoped to the 12 seed templates rather than to
the economy. Concretely: the capex list and the recurring-cost list for each template, at three quality tiers
where tiers exist (used / mid / new). Roughly 40 items per template. This is ~3 weeks of content work for one
domain-literate person and it runs in parallel with M1–M2, so it does not extend the critical path — but it
must *start* in week 1, and it is the single most common way this kind of project slips.

Licensing (IBISWorld, RMA Annual Statement Studies, NRA Operations Report) is worth pricing for the *benchmark
bands* specifically, since those carry a citation into the export and a real source is worth more there than a
good guess. The item-level catalog is cheaper to build than to license.

### D-3 · Does the player see the engine's formulas?

**Agree: hide by default, expose behind "show the math" on every derived figure.**

The architecture makes this nearly free — the provenance trace (architecture §5) is already threaded through
every computation for §10.4, and "show the math" is that same data rendered differently. Build the trace for
§10.4, get §16 Q3 as a side effect.

The audience argument in the spec is correct and worth going further on: the person who wants to see the
formula is disproportionately the person who will trust the tool enough to take its output to a lender. Do not
make it a hidden setting; make it a click on any number.

### D-4 · The export is a second engine — treat it as one

Not one of the spec's four questions, but the largest under-estimation in the document.

§12 requires **live formulas, not pasted values**: "Every statement cell must reference the Assumptions sheet."
Combined with §12.2's requirement that monthly interpolation reconcile exactly to the quarterly sheet, this
means the workbook must contain a working reimplementation of the engine in Excel formula language —
maturity ramps (`EXP`), elasticity (`^`), marketing response, step-fixed `CEILING`, working-capital
rollforwards, debt amortisation, NOL carryforward, the lot.

Two implementations of the same arithmetic diverge. That is not a risk, it is a certainty, and the divergence
will be found by a founder in front of a lender rather than by us.

**Mitigation, non-negotiable and in place from the first commit of M6:** emit the workbook, recalculate it
headlessly with [HyperFormula](https://hyperformula.handsontable.com/), and diff every statement cell against
the engine's own output for the same model at every period, to the cent. Any divergence fails CI. Run it across
all 12 seed templates as part of the golden-file suite.

Two things follow from taking this seriously:

- **Some engine behaviour cannot be expressed as a spreadsheet formula** — specifically the crisis-resolution
  loop (§9.4), which is iterative and path-dependent. Excel circular references with iterative calculation are
  a trap. **Recommendation:** the workbook models the *base case without crisis remedies*, and the Summary
  sheet states plainly that remedies applied during the run are shown on the Run History sheet but are not
  re-derived by the formulas. Peak cash need is what the workbook exists to reveal; a founder does not need
  the model to re-simulate their revolver draws.
- **Scope the formula depth deliberately.** Sheets 4/5 (quarterly, annual) get full live formulas — that is
  where the value is. Sheet 3 (monthly Y1) is explicitly interpolated and can be formula-driven off the
  quarterly sheet. Sheets 9/10 (debt, capex) are naturally formulaic. Sheet 11 (run history) is a record and
  should be values.

### D-5 · The absurdity principle — the AI pushes back on impossibility, never on implausibility

Also not one of the spec's four questions, but the one that decides what the product is for.

A tool that filters ideas for plausibility filters out precisely the ideas worth modelling. Enough
enormously successful businesses looked ridiculous at the outset that "this sounds unlikely to work" is
worthless as a gate — and a founder who wanted that verdict could get it anywhere, for free. The reason to
build this is the opposite case: someone wants to know what a strange idea would actually cost, and what
would have to be true for it to clear. Had a sovereign wealth fund been able to run *The Line* through
something like this before committing capital, the useful output would not have been "no."

**The rule, binding on every M3/M4 prompt:**

> The AI pushes back on **physical and contractual impossibility** and on nothing else. Not commercial
> implausibility. Not "no comparable exists." Not "the benchmark says otherwise."

An ice cream shop with 256 flavours might be a bad business, but anyone with the money can open one, so the
system's job is to model it, not to have an opinion about it. What it *is* allowed to say is that 256
flavours means 22 dipping cabinets, a slower counter, and inventory that turns half as fast — because those
are consequences, not judgements.

What counts as impossible, and is therefore fair to refuse:

- **Arithmetic and identity** — accumulated depreciation exceeding an asset's depreciable base, a period
  ending with cash that was never received, a balance sheet that does not balance.
- **Contract** — zero payroll load on employed staff, zero rent on a leased space, a lease with no
  escalator asserted as a lease *with* one.
- **Physics and law** — capacity exceeding what the stated footprint and hours permit, a licence that does
  not exist, delivery in negative time.

Everything else is a condition to be surfaced, not a door to be closed. §11.2's own framing is the standard:
*"a business that is viable under some conditions and not others. The player should learn what those
conditions are, not be told yes or no."*

**Two consequences that change how M3 must be built:**

1. **A novel concept gets NO benchmark bands, rather than borrowed ones.** The tempting shortcut is to map
   an unfamiliar concept to the nearest seed template and inherit its bands. Do not. *The Line* has no
   comparable; if it inherits self-storage's bands, every line flags out-of-band, and out-of-band reads as
   "this is wrong" when the truth is "nobody knows." An absent band is honest; a borrowed band is a
   fabrication wearing a citation. The register already ranks provenance for exactly this reason —
   `LLM_ESTIMATE` with no band and a visibly low confidence score is the correct representation of a
   genuinely novel cost line.
2. **The LLM emits cost lines directly for concepts outside the twelve templates**, at `LLM_ESTIMATE`
   provenance, rather than borrowing a template's cost structure and relabelling it. A borrowed structure is
   wrong in ways nobody can see; an estimated one is wrong in ways the register displays.

**Benchmarks are weak constraints, not absent ones.** An absent band means "no comparable exists," not "any
number goes." A 256-flavour shop may well charge more than Ben & Jerry's; it cannot charge $200 a scoop. And
because it needs a bigger store, it may take far more revenue than a Ben & Jerry's benchmark would suggest —
but it is still bound by the same arithmetic: it can only serve so many people a day at such and such a
price. There is no single-location ice cream shop with a billion dollars of revenue.

The useful reading of that: **the constraint that binds is not the benchmark value, it is the identity that
produced it.** Revenue is servable customers × price. Either factor can move a long way outside its band —
that is the whole point of modelling a novel concept — but the *product* is bounded by physical facts:
footprint, operating hours, service time per customer. That bound is arithmetic, not opinion, and the engine
already computes it. The 256-flavour shop is capped at $302k a quarter on a 30-position counter not because a
benchmark says so, but because 30 × 12 × 91 ÷ 1.268 is 25,836 customers and they are paying $13 each.

So there are three tiers, not two:

| Tier | What it covers | Response |
|---|---|---|
| **Impossible** | Arithmetic, contract, physics — including *derived* ceilings: claimed revenue that cannot reconcile to volume × price, or capacity that cannot fit the stated footprint | **Refuse.** Cannot be overridden. |
| **Far outside any anchor** | A value many multiples from the nearest defensible reference — $200 a scoop, 40% capture of a metro trade area | **Challenge, and report the magnitude.** Never refuse. |
| **In band, or modestly outside** | Everything else | **Register and move on.** |

Two consequences for the build, both now implemented:

1. **The register carries a deviation *magnitude*, not just a boolean.** `outsideBenchmark` can only say
   "outside," which is the same word for 1.2× and 22× and is therefore useless as a weak constraint.
   `Assumption.benchmarkDeviation` measures the miss in **band-widths** — signed, zero inside — and
   `deviationLabel()` renders the founder-facing phrasing (*"17× the top of the range"*), falling back to
   band-widths when the band straddles zero and a multiple would mislead. Band-widths rather than a raw
   ratio because a seed-stage SaaS EBITDA band genuinely runs −15% to 30%, and `value / low` is meaningless
   against a negative edge. The register review now sorts by magnitude, so the startling number is the one a
   founder sees first. This is what lets M4 ask *"what makes 22× true?"* instead of announcing *"out of
   band"* — the first is a question, the second is a verdict.
2. **The capacity model carries a footprint, and validation checks it.** `floorAreaSqFt` is a **required**
   field on `SEAT_TURNS`, not an optional one: a capacity claim with no box behind it is unfalsifiable, and
   an optional field would simply be omitted by the concepts that most need it. `MIN_SQ_FT_PER_SEAT = 7`
   comes from IBC Table 1004.5 (assembly standing space is 5 net sq ft per occupant; concentrated seating
   is 7), applied against *gross* floor area — so it sits well under anything real and only catches
   fabrications. Over-capacity is a hard `CAPACITY_EXCEEDS_FOOTPRINT` error, and the message says what would
   have to be true rather than just refusing: *"Either take 700000 sq ft (and carry the rent) or seat 261."*

   The same bound had to go into `EXPAND_CAPACITY`, which previously added seats with nothing checking them
   — validation only ran at concept lock, so a player could reach any capacity by repeating the buildout.
   The action now takes an optional `deltaFloorAreaSqFt`, applied *before* seats: take the space and the
   seats are yours, along with the rent. That argument belongs on the player's P&L, not in a refusal.

Note what neither of these does: nothing here refuses $200 a scoop. It is physically possible, so it gets
modelled. What the engine already has is the honest consequence — price elasticity anchored at the price set
at concept lock — so a player who raises the ticket 22× and *also* holds capture rate flat is making a second,
separate claim: that 44,200 people will pay it. That claim is a `PLAYER_ASSUMED` assumption with no source,
sitting many multiples outside any anchor, and interrogating it is precisely M4's job. The absurdity principle
does not mean the system is credulous. It means it argues about assumptions rather than about concepts.

**Where this is enforced:** [`packages/engine/src/absurdity.test.ts`](../../packages/engine/src/absurdity.test.ts)
builds the 256-flavour shop as its own template — own cost lines, own capex, `plausibility: {}` — and asserts
the whole shape of this decision: that validation has no opinion on it, that the complexity is charged in
throughput, freezers and inventory days, that nothing is flagged out-of-band against numbers that do not
exist, and that the concept is *conditionally* viable. The condition it surfaces is the useful part: 256
flavours loses money on a 30-position counter at any price, and clears 14% EBITDA on a 40-position one,
because the novelty draws a queue the original shop cannot serve. That is the output this product owes a
founder — not a verdict.

---

## Risk register

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R-1 | Seed calibration takes far longer than budgeted | Slips M2, blocks M3 | **High** | Appendix A recorded 3 iterations for 1 template. Budget 2w for 12. Build sim-cli in M0. Give it a domain-literate owner, start week 1 |
| R-2 | Export diverges from engine | Credibility loss at the exact moment of maximum stakes | **High** without mitigation | HyperFormula recalc diff in CI (D-4) |
| R-3 | Provenance tracing retrofitted late | Touches every formula in the engine; effectively a rewrite | Medium | Thread the trace in M1c, before there are 6 archetypes of formulas to edit |
| R-4 | Adjudication sycophancy regresses on model change | Silent; the product becomes a wishful-thinking launderer | Medium | CI regression gate; pin the model version; re-run fixtures on every model bump |
| R-5 | `blocksNeeded` wired to realized volume | Revenue freezes for 10 simulated years; all assertions still pass | Medium | The spec's own reference implementation shipped this. Regression test in M1, not M2 |
| R-6 | Crisis loop leaves stale statements | §8.4 assertion fires in production, or worse, is disabled | Medium | Re-enter at step 8 as specified; test every remedy with a full assertion run after |
| R-7 | LLM schema conformance below 99% | Synthesis failures block the funnel at its narrowest point | Medium | Derive JSON Schema from the same zod objects; retry-with-error; structured error state, never coercion |
| R-8 | Tick performance blows the sensitivity budget | Export becomes unusably slow | Low–Medium | ≤1ms tick budget, benchmarked in CI (below) |
| R-9 | UI scope discovered late | The spec specifies UI in one diagram | Medium | UI track starts during M1; three-pane shell before M3 needs it |
| R-10 | Property tests find articulation bugs deep in M2 | Rework across archetypes | Low | Run the §13.1 suite per archetype as each lands, not at the end of M2 |

---

## Performance budgets

Not preferences — [G-10](./03-spec-gaps.md#g-10--sensitivity-analysis-cost-is-unbounded) makes these product
requirements. Benchmark in CI and fail on regression.

| Operation | Budget | Driven by |
|---|---|---|
| Single `tick()` | **≤ 1ms** | Sensitivity analysis: up to ~48,000 ticks per export |
| 40-quarter run | ≤ 50ms | Property tests: 6 archetypes × 1,000 cases |
| §13.1 full property suite | ≤ 5 min | Must be runnable on every PR, or it will be skipped |
| Sensitivity analysis (full export) | ≤ 30s | Interactive export flow with a progress indicator |
| Workbook generation | ≤ 10s | Same |
| `ConceptInterview` turn | ≤ 3s p50 | Conversational feel; one question at a time makes latency compound |
| `ChallengeAdjudication` | ≤ 5s p50 | The player is arguing in real time — this is where retrieval latency (D-1) would land |

The tick budget is achievable given engine purity, but only if `Money` arithmetic does not allocate
excessively. Benchmark early; bigint allocation in a hot loop is the likely culprit if the budget is missed.

---

## What "done" means for the MVP

A prospective founder can:

1. Describe a business in plain language and be interviewed until the model has what it needs
2. See every assumption with its value, range, provenance, benchmark band, and source
3. Argue with any of them — and be conceded to when right, defended against when wrong, and asked a
   discriminating question when plausibly right but underspecified
4. Operate the business for 40 quarters, taking actions with real lead times and real consequences
5. Fail, and receive a specific, checkable "what would have had to be true" analysis
6. Export a workbook with live formulas whose numbers match the simulation to the cent, showing peak cash
   need, an assumption register colour-coded by provenance, and a tornado chart pointing at what to go verify
   before signing a lease

And at no point does a number on a financial statement originate from a language model.
