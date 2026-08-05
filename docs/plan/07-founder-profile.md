# 07 — The founder profile: setup inputs that carry load

Status: **specced, not built.** Approved direction from the 2026-08-05 design
session; build in the four stages at the bottom, each shippable alone.

## The law this exists to enforce

**Never collect what the model won't carry.** Every setup input must discharge
somewhere the player can point at — the register, the world, the lender's
file, or the questions the interview asks next. "Username:" fails the test
because nothing in the game varies with it. Capital passes: it scales the
concept, the funding proposal, and the depth gauge. This is the eigen-question
law generalised from questions to inputs: an input whose answer changes
nothing is a form field wearing a game's clothes.

The immediate motivation is the action-bar redesign's one real risk: the old
wall of forms was also a menu of what's possible, and deleting it may shrink
the strategy space players consider. The durable answer is not more resident
UI — it is making the game *about the player* early, so the things they told
us keep showing up in play, teaching by consequence rather than by menu.

## What the interview learns, and where it goes

One new must-ask person-question (it joins the differentiation / ambition /
owner-earnings trio from the Toledo feedback): **experience with this
concept's domain.** "Have you done this before — run one, worked in one, or
is this new ground?" The answer is richer than any checkbox: "I ran the books
for my dad's HVAC company" carries years, role, and adjacency in one sentence.

The draft gains a `founderProfile` block, emitted from the transcript like
everything else:

```ts
founderProfile: {
  /** Years of hands-on experience in this concept's domain. 0 = new ground. */
  domainYears: number,
  /** What the player says they will personally work. */
  ownerHoursPerWeek: number,
  /** The player's words the numbers came from — quoted in sourceNotes. */
  basis: string,
}
```

Two hard rules, both prompt laws with tests:

1. **Biography is never invented.** `domainYears` and `ownerHoursPerWeek`
   come only from things the player actually said. Unasked or unanswered →
   neutral defaults (0 years, 40 hours) and **no effects**. A model that
   infers "probably experienced" from tone has fabricated a credential.
2. **Every effect is a register line.** No hidden multipliers, ever. Each
   mapping below lands as a visible, challengeable assumption whose
   sourceNote quotes the player ("your nine years running kitchens").
   Persona effects that bypass the register would be the sim flattering the
   player — the one thing this product promises not to do.

## The four effect mappings

**1. The ramp (§3.7).** `rampFloor` is a constant 0.4 for everyone today. An
operator who has run one before opens faster — they know suppliers, hiring,
permits. Deterministic mapping in `toTemplate` (input-shaping, same class as
`monthlyFromQuarterly` — the LLM computes nothing):

```
rampFloor = min(0.60, 0.40 + 0.025 × domainYears)
```

Registered as an assumption ("Opening ramp floor — your N years in the
trade"), challengeable, exported. Zero years changes nothing.

**2. The owner-supplied block.** "I'll run it myself, 80 hours a week" is the
industrious persona *declared in the player's own words* — no picker needed.
Engine primitive (this is the deferred owner-2-blocks item): `ownerBlocks:
0 | 1` on a step-fixed line. It counts toward capacity but adds no block
cost — the owner's labor is already paid through the owner-comp fixed line,
and paying it twice would be the duplicate-overheads bug in reverse. Fires
only when `ownerHoursPerWeek ≥ 60` **and** the concept has a primary labor
line the owner could plausibly work. Register line: "Owner works the line —
one block of Core crew is you." Removable in play (the `assume` lever or a
dedicated action) because 80-hour weeks are not forever; removing it is how
the game prices burnout without moralising about it.

**3. The lender's file.** Real SBA underwriting prices operator experience.
`domainYears ≥ 5` earns one pricing-tier spread reduction and a modestly
higher collateral ceiling (×1.15) in `openingLoanRate` / `underwrite`.
Shown on the funding cards in depth-gauge style — *chosen, visible, priced*:
"your nine years shave 0.5%." Deterministic; both frontends read the same
`funding.ts` arithmetic, so they cannot quote different files.

**4. Expertise is evidence (§11.3).** The honest version of "the AI believes
you more." The adjudicator stays exactly as skeptical about the *world*; what
changes is that a domain expert's bare assertion **within their domain**
counts one evidence tier higher — a chef's unadorned "food cost runs 26%"
moves the number the way a cited basis would for a layman, still bounded by
D-5's weak constraints and still recorded with its actual provenance. Outside
their domain, nothing changes. This is not credulity; it is provenance doing
its job — expertise is a source, and the register already ranks sources.

## What deliberately does not ship

- **A persona picker.** "Industrious / Creative" as a select screen is the
  wall of forms one level up: three archetypes where the conversation
  captures forty shades. The mechanics above give the personas' effects to
  whoever *talks like them*. Revisit only if transcripts show players never
  volunteering this material even when asked.
- **The industry multi-select.** Its one unique power — shaping idea
  generation before a concept exists — ships first as a prompt behaviour
  (the interview asks the daydreamer what they know before suggesting
  ideas), not a screen. The screen waits for evidence the question misses.
- **Marketing-effectiveness bonuses ("creative").** Deferred entirely:
  marketing chops are hard to establish from a sentence, and a wrongly
  granted `marketingMaxLift` bonus distorts every quarter. If it lands, it
  lands through the same expertise-as-evidence door: claims about marketing,
  adjudicated, in a marketer's domain.
- **Any adjudicator effect beyond the one-tier rule.** The challenge loop's
  integrity is the product.

## Build order — four stages, each shippable

1. **Wire + law.** `founderProfile` on `zConceptDraft` (defaulted neutral so
   every existing transcript and fixture still parses), the interview law +
   prompt-pin tests, the biography-is-never-invented test (a transcript with
   no experience statement must produce neutral defaults). No effects yet —
   the field flows to the journal and the drafting context only.
2. **Ramp + owner block.** The `toTemplate` mapping, the `ownerBlocks`
   engine primitive with its statement treatment (capacity yes, payroll no,
   articulation tests), both register lines. This is the stage that needs
   engine care — the §13.1 property suite runs over models with an owner
   block.
3. **Lender file.** The pricing-tier and ceiling nudges, funding-card line,
   CLI parity via shared `funding.ts`.
4. **Expertise-as-evidence.** The one-tier rule in `argue.ts`, with the
   sycophancy regression extended: an expert bare assertion moves further
   *in domain*, not one inch further out of domain, and never past D-5.

## Signals to watch in play-tests

- Does the interview get experience material without the question feeling
  like a form? (It should ride the existing person-question rhythm.)
- Does the player ever *point at* a profile effect ("that's my experience
  showing up") — the load-bearing law's felt version?
- Challenge transcripts in-domain: does the one-tier rule read as respect or
  as the game going soft? The line between them is D-5.
