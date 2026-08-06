# Show the math (§16 Q3)

The spec's own recommendation: *"hide by default, expose behind a 'show the math' affordance on every
derived figure. The audience for this product is disproportionately the kind of person who will want it."*
[01-architecture.md §5](./01-architecture.md) adds that the §10.4 trace makes this "a data-availability
problem rather than an engineering one", and [02-milestones.md](./02-milestones.md) calls it cheap.

Both are half true. The trace records **which assumptions can move a line** — it deliberately discards the
values and the operations, because §10.4 only ever needed the dependency graph. Revenue's trace says
`captureRate` fed it. It does not say `× 8.0%`.

So the affordance needs one thing the trace does not carry: the arithmetic as it actually ran.

---

## The law

**A derivation is recorded where the formula lives, never reconstructed where it is displayed.**

The tempting shortcut is to read the parameters out of `WorldState` in the view layer and multiply them
back together for display. That is a second implementation of every formula in the engine, kept in sync by
hope. It will drift, and the first thing the player will do with a "show the math" panel is find the case
where the math shown does not make the number above it — which destroys the credibility the feature exists
to build.

This is the same rule as §1.1, pointed at a different offender. §1.1 keeps the LLM from computing a
statement value. This keeps the *view* from computing one. The only code allowed to say how a figure was
derived is the code that derived it.

Two corollaries:

- **A derivation carries values, not formatted strings.** The engine emits `{ kind: 'money', cents }` and
  `{ kind: 'rate', value }`; the view decides that a rate renders as `8.0%`. Formatting is presentation and
  the CLI wants different presentation from the browser.
- **A figure with no recorded derivation shows no affordance.** Not an empty panel, not "not available" —
  nothing. An affordance that opens onto nothing teaches the player the feature is unreliable.

---

## Mechanism

`TickContext` gains one method beside `p` and `scope`:

```ts
derive(key: string, derivation: Derivation): void
```

Called once, atomically, by the code that owns the formula. It does not touch the scope stack and does not
feed `byLine`/`byPath`, so §10.4 attribution is untouched by construction. `NullTracer` ignores it, so the
property suite (240,000 quarter-ticks) pays nothing.

```ts
interface Derivation {
  label: string;                 // "Espresso — demand"
  line?: TraceKey;               // the statement line this rolls up into
  steps: DerivationStep[];       // the arithmetic, in the order it ran
  result: DerivedValue;
}

interface DerivationStep {
  label: string;                 // "Addressable traffic"
  value: DerivedValue;
  op?: '×' | '÷' | '+' | '−';    // how this step joins the previous one
  path?: string;                 // assumption path — the register row that sets it
  note?: string;                 // "capped at the physical ceiling"
}
```

`path` is what makes the panel more than a readout: every step that came from an assumption names the
assumption, which is the row the player can already argue with. Show-the-math and the challenge flow are
the same loop seen from two ends.

---

## What gets a derivation

**Stage 1 — the income statement.** Everything above net income, which is where the player's decisions
land and where every "why is this number that" question in play-testing has been aimed.

| Figure | Where it comes from |
| --- | --- |
| Revenue, per stream | `computeDemand` + `realize` — the factor chain, then served volume × price |
| COGS / Labor / Occupancy / Marketing / G&A | the four cost classes in `costs.ts`, one derivation per cost line, rolled up by statement line |
| Gross profit, EBITDA, EBIT, pretax, net income | structural: assembled from the statement itself |

The subtotals are the one place the law relaxes, and deliberately: `Gross profit = Revenue − COGS` is not a
re-derivation, it is a restatement of two figures already printed on the same screen. There is nothing to
drift from.

**Deferred to stage 2:** the metric tiles (runway, peak cash need, margin), the balance sheet, the cash
flow statement, and the capacity/utilisation line. Stage 2 is mostly more of the same instrumentation; the
mechanism does not change.

---

## Presentation

Hidden by default, one disclosure per row, opened per figure and not globally. The panel shows the steps as
a column of `label · op · value`, the result, and — where a step names an assumption — the register row it
came from.

The panel is not a second statement. It never re-prints the figure it hangs under as its own headline; the
row above it is the headline.

---

## Signals it worked

- A player who disputes a number opens the panel instead of asking the advisor. The advisor's money guard
  exists because prose about figures is expensive to keep honest; arithmetic needs no guard.
- The panel is opened during setup review, not only in play. "Show me how you got that" is the same
  question as "I want to argue with that", and they should meet at the same row.
