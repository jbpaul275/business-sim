# Spec gaps requiring a decision

Found while reading spec v1.0 end to end. Each is something an implementer will hit and have to guess at.
Guessing produces a plausible engine that is subtly wrong — the failure mode Appendix A already documents once.

Ordered by when they block work. Each carries a recommendation so none of these needs to stop a build.

---

## G-1 · `spendRatio` has no definition for four of six archetypes
**Blocks: M1** · §3.0, §3.3, §3.4

`spendRatio = marketingSpendPerQuarter / baseMarketingSpendPerQuarter` is listed as a **common index term** used
by all archetypes. But `baseMarketingSpendPerQuarter` exists only on `UnitsCacParams` and `SubscriptionParams`.
TRAFFIC, UTILIZATION, OCCUPANCY and PROJECT_BACKLOG have no such field, so `spendRatio` is undefined for them —
divide by undefined.

In practice `spendRatio` is only consumed by `cacInflationCoefficient`, which only those two archetypes have.
So the term is over-declared rather than the field being under-declared.

**Recommendation:** move `baseMarketingSpendPerQuarter` to `SharedModifierParams` (it is also the natural
reference point for `halfSaturationSpend` calibration), and state that `spendRatio` is consumed only by CAC
inflation. Cheap, and it keeps the §10.2 completeness invariant satisfiable for every archetype.

---

## G-2 · PROJECT_BACKLOG has two marketing fields
**Blocks: M2** · §3.0.5, §3.6

§3.0.5: marketing is `RevenueStream.marketingSpendPerQuarter`, it is a `MARKETING` statement line, booked in
the quarter incurred. §3.6 gives `ProjectParams.bizDevSpendPerQuarter` and uses *that* in the win-rate
calculation.

Two consequences, both bad: `bizDevSpendPerQuarter` drives revenue but is never stated to hit the income
statement (an uncosted growth lever — the model prints money), while `marketingSpendPerQuarter` on a
PROJECT_BACKLOG stream is expensed but drives nothing.

**Recommendation:** delete `bizDevSpendPerQuarter`. PROJECT_BACKLOG reads `marketingSpendPerQuarter` like
every other archetype; relabel it "business development" in the UI for this archetype only. One field, one
cost, one effect.

---

## G-3 · Labour capacity is business-level but constrains streams
**Blocks: M1** · §3.1, §4.3

`CostStructure` lives on `Business`. `stepFixedLaborCapacity` binds revenue on a `RevenueStream`. When a
business has multiple streams — the gym in §3's own example is SUBSCRIPTION + UTILIZATION + UNITS_CAC — the
spec does not say how one pool of staffed capacity is allocated across them, nor what happens when several
step-fixed lines share a driver (a restaurant with both "line cook" and "server" blocks on `TRANSACTIONS`).

**Recommendation, two rules:**
1. **Multiple blocks, same driver:** staffed capacity is the `min` across all step-fixed lines carrying that
   driver. The tightest station gates the line — which is how kitchens actually work.
2. **Multiple streams, same driver:** allocate capacity across competing streams in proportion to
   unconstrained demand. Record the allocation in the trace so the player can see it.

Add `appliesToStreamIds` to `StepFixedCost` (mirroring `VariableRevenueCost`) so a business *can* dedicate a
block to one stream when that is the truth. Default `'ALL'`.

---

## G-4 · `StepFixedCost` driver units don't typecheck
**Blocks: M1** · §4.3

`driver` may be `'REVENUE'`, but `capacityPerBlock: number`. Revenue is `Money` (bigint). `ceil(demandVolume /
capacityPerBlock)` mixes bigint and float. The same field means transactions (count), billable hours (float),
and dollars (bigint) depending on the driver.

**Recommendation:** discriminate the type.

```ts
type StepFixedDriver =
  | { kind: 'TRANSACTIONS' | 'BILLABLE_HOURS' | 'OCCUPIED_UNITS' | 'PROJECTS_ACTIVE';
      capacityPerBlock: number }
  | { kind: 'REVENUE'; capacityPerBlock: Money };
```

Same treatment for `VariableActivityCost.driver`, where `'REVENUE'` as an activity driver is arguably a
category error anyway — §4.2's whole point is that activity costs are *decoupled from revenue dollars*. Consider
dropping `'REVENUE'` from `ActivityDriver` entirely; a cost that scales with revenue is a `VariableRevenueCost`.

---

## G-5 · Per-stream DSO is described but not typed
**Blocks: M1** · §3.6, §5.1

§5.1 computes `AR_end = Σ over streams (streamRevenue * (streamDsoDays / 91.25))`, but `dsoDays` lives once on
the business-level `WorkingCapitalPolicy`, and only PROJECT_BACKLOG's `progressBillingLagDays` is named as an
override. `streamDsoDays` is used but never defined.

**Recommendation:** define explicitly —
`streamDsoDays = stream.archetype === 'PROJECT_BACKLOG' ? params.progressBillingLagDays : wc.dsoDays`
— and add an optional `dsoDaysOverride` to `RevenueStream` for the general case (a retail shop with a small
wholesale line has genuinely different terms per stream). Register both as assumptions.

---

## G-6 · Quarterly engine vs. annual tax thresholds
**Blocks: M1** · §7.1, §7.2

Self-employment tax is "15.3% on the first $168,600 of net earnings and 2.9% above". That is an *annual*
threshold on an engine that ticks quarterly. The §179 cap ($1.22M, phasing out above $3.05M) and
`TaxState.section179UsedThisYear` are also annual. NOL's 80% limitation is annual.

Applying an annual threshold per quarter overstates the 15.3% band by up to 4×.

**Recommendation:** carry year-to-date accumulators on `TaxState` (`ytdNetEarnings`, `ytdSeTaxPaid`,
`section179UsedThisYear`) reset at `currentPeriod % 4 === 0`, and compute each quarter's tax as
*(tax on YTD income) − (tax already provided YTD)*. This is also how real quarterly estimated payments work,
so it is both more correct and more recognisable to the player. Add an assertion that the four quarterly
provisions of any complete year sum to the annual calculation.

Related: §7.1 says pass-through tax distributions happen "in the quarter the tax is owed" without saying which
quarter that is. The YTD-true-up approach answers this too — the distribution is the incremental provision.

---

## G-7 · No income statement line for disposal gains or factoring discount
**Blocks: M1** · §8.1, §8.3, §8.4, §9.4

The income statement (§8.1) runs Revenue → COGS → Labor → Occupancy → Marketing → G&A → EBITDA → D&A → EBIT →
Interest → Pre-tax → Tax → Net income. There is no line for non-operating items. But:

- `DISPOSE_ASSET` (§9.3) sells an asset at a price that will not equal net book value. The gain or loss must
  reach net income, or `retainedEarnings_end === retainedEarnings_begin + netIncome − distributions` (§8.4)
  fails the first time a player sells a truck.
- `SALE_LEASEBACK` (§9.4 remedy 6) has the same problem, inside the crisis loop.
- Factoring receivables at a 3–5% discount is "recorded as a financing expense" — but there is no financing
  expense line, and §8.3 shows financing as a *cash flow* section, not an expense category. The discount is a
  real cost of ~4% of AR and must hit the P&L somewhere.

**Recommendation:** add between EBIT and Pre-tax income —

```
= EBIT
- Interest expense
+/- Gain (loss) on asset disposal
- Financing and factoring costs
= Pre-tax income
```

Both new lines are below EBITDA, so no benchmark band, DSCR calculation, or break-even figure changes.
This is a small edit to §8.1 that prevents an §8.4 assertion failure in production.

---

## G-8 · `deferredOwnerComp` accrues with no repayment rule
**Blocks: M5** · §2.4, §9.4

Crisis remedy 4 defers owner compensation, which "accrues as a liability, does not vanish". Nothing says when
or how it is paid. Left unspecified, the liability grows monotonically forever, quietly flattering the balance
sheet's liability side while the founder is, in the fiction, going unpaid indefinitely.

**Recommendation:** repay automatically from operating cash when quarter-end cash (after all other outflows)
exceeds one quarter of living expenses plus a one-quarter operating buffer, oldest deferral first. Surface the
outstanding balance in derived metrics — "you are owed $84,000 in back pay" is exactly the kind of honest
number this product exists to produce. Include it in the household's economic-return calculation (§8.5).

---

## G-9 · Household insolvency ordering inside the tick
**Blocks: M5** · §9.2 step 15, §9.4

§9.2 is explicit that household outflows (15) precede the business crisis check (18), and gives a good reason.
But §9.4's household resolution ladder includes "take a distribution from any business with positive cash" —
a business whose own cash position has not yet been resolved at step 15. The two ladders can each be waiting
on the other.

**Recommendation:** run household resolution *after* the business crisis loop converges, as step 18b, with one
constraint: a business may only distribute cash that survives its own crisis resolution. Insert the household's
living-expense and personal-tax *outflows* at 15 as the spec says (so they are visible to the business crisis
check), but defer household *remedies* until business cash is known. Document that the household can go
transiently negative inside the tick and must be non-negative at step 22 — and add that to §8.4's assertions,
which currently check only `business.cash >= 0n`.

---

## G-10 · Sensitivity analysis cost is unbounded
**Blocks: M6** · §12.3

"For each registered assumption, hold everything else constant and vary it across its `range`." The §10.2
completeness invariant guarantees *every* engine parameter has an assumption — for a multi-stream business
that is plausibly 150–400 assumptions. At 3 points per range × 40 quarters, that is 18,000–48,000 quarter-ticks
per export.

That is fine at ~0.5ms/tick (~10–25s) and unusable at 20ms/tick. It makes the tick performance budget a
product requirement rather than an engineering preference.

**Recommendation:** (a) set the tick budget at ≤1ms and test it (see performance budgets); (b) prune using the
§5 trace — an assumption no statement line reads cannot move output, so skip it; (c) run the full range sweep
only for the top ~40 by first-pass 2-point screening, then refine those.

---

## G-11 · Free-play capital breaks the money-as-string assumption boundary
**Blocks: M0 (cheap to prevent), §16 Q4**

FREEPLAY is "custom, uncapped". `Number.MAX_SAFE_INTEGER` cents is ~$90 trillion — bigint handles more, but
JSON round-tripping, `exceljs` cell values, and every float quantity multiplication do not. The spec's own §16
Q4 flags the modelling problem; there is a representation problem underneath it.

**Recommendation:** cap FREEPLAY starting capital at $1B and say so in the UI. It preserves the mode's spirit,
keeps every number inside safe float range for the export, and sidesteps the "$10B coffee shop" plausibility
problem §16 Q4 raises. Add a schema-level bound so it is enforced once.

---

## Found during implementation

These were not visible from reading alone. Each one produced a real articulation
failure or a nonsensical run, and each is fixed in `packages/engine`.

## G-12 · `deferredOwnerComp` is missing from ΔNWC
**Found: M1** · §5.2, §9.4

§5.2 lists AR, retainage, inventory, prepaid, AP, accrued and deferred revenue.
It omits `deferredOwnerComp`, which §2.4 puts on the balance sheet and §9.4 remedy 4 creates. It is a liability
that funds operations exactly as deferred revenue does, so the moment the remedy fires,
`endingCash === beginningCash + CFO + CFI + CFF` stops holding.

**Resolved:** included in ΔNWC.

## G-13 · Deferring owner comp must not also remove the expense
**Found: M1** · §9.4

The obvious reading of remedy 4 — drop the cost from the period — hands the business the relief twice: once as
higher net income and again as a liability that releases cash through ΔNWC. Deferring $21k of pay produced $42k
of cash.

**Resolved:** the expense stays on the P&L and accrues to the liability. §9.4's own words settle it — the
deferral "accrues as a liability, does not vanish". The work was done; the founder is owed for it.

## G-14 · Debt origination fees have nowhere to land
**Found: M1** · §8.1, §8.3

§8.3 lists origination fees as a financing cash outflow. §8.1 has no line for them. Model it literally and cash
leaves with nothing on the other side of the entry: the balance sheet is off by exactly the fee, forever. In a
run with an SBA loan and a few crisis draws this surfaced as a $500 discrepancy a hundred periods in — long
after the loan that caused it.

**Resolved:** expensed to the `financingCosts` line added under G-7, then reclassified — added back within
operating, subtracted within financing. Standard treatment for debt issuance costs; puts the fee where §8.3
asks for it; ties.

## G-15 · Crisis remedies fund the shortfall exactly, so the ladder never closes
**Found: M1** · §9.4

Every remedy induces a cost of its own: interest on the draw, an origination fee, a new lease payment. Raising
exactly the shortfall therefore leaves a smaller shortfall behind. The sequence converges — $5,943 → $137 →
$3.17 — but never reaches zero inside the three passes §9.4 allows, so a business three dollars short is
declared insolvent.

**Resolved:** remedies raise the shortfall plus 10% headroom, covering one quarter at the ladder's most
expensive rate. Nobody draws a revolver to the last cent anyway.

## G-16 · The lender of last resort has no limit, so nothing ever fails
**Found: M1** · §9.4

Neither emergency debt (remedy 5) nor the household's personal borrowing carries a ceiling in §9.4. Without
one, a failing business simply accumulates debt at prime + 12% forever and the run never reaches the insolvency
the spec is explicit the sim should be willing to show. A deliberately under-staffed reference business
survived all ten years and finished $7.3M underwater, still marked `OPERATING`.

**Resolved:** emergency debt is capped at roughly a year of revenue less existing debt; household borrowing is
capped at the starting capital, as a proxy for the home equity and credit lines the founder began with. The
same business now closes in year three with the founder down $297k — the honest end state.

## G-17 · Factoring can sell receivables that do not exist
**Found: M1** · §9.4

Remedy 3 factors receivables and the AR balance is floored at zero afterwards. If the remedy is sized against
the post-factoring balance — or against a balance smaller than the amount sold — the clamp silently swallows the
difference and the cash raised has no offsetting entry.

**Resolved:** the remedy is capped against gross receivables, computed before any factoring is applied.

---

## Minor items — decide when reached, no recommendation needed

| # | § | Item |
|---|---|---|
| m-1 | 3.3 | `orders = (newOrders + repeatOrders) * priceEffect` applies elasticity to customers already acquired *and paid for* via CAC. Defensible (price affects basket) but double-counts against `avgOrderValue` elasticity. Calibration decision |
| m-2 | 3.3 | `state.customers = (begin + new) * (1 − attrition)` churns new customers in their first quarter, before they have ordered twice. Probably intended; worth a comment either way |
| m-3 | 3.5 | OCCUPANCY multiplies `stabilizedOccupancy` by `priceEffect` then clamps at 1.0. A price *cut* on an already-88%-occupied asset does nothing, which is correct, but the clamp means the elasticity assumption is untestable in that region. Note it in the register |
| m-4 | 6.3 | `RAISE_DEBT` is underwritten on trailing EBITDA, but proceeds arrive +1 quarter (§9.3.1). Test DSCR at submission or at funding? Recommend submission — that is when a lender underwrites |
| m-5 | 9.3 | `SELL_BUSINESS` has no specified tax treatment of the gain, and no rule for what happens to outstanding debt at close |
| m-6 | 2.2 | `WorldConfig.annualInflationPct` is documented as used "only for delegated-business drift", but §9.6 escalates delegated *marketing spend* by it, not margin. `FixedPeriodCost.annualEscalatorPct` covers cost inflation separately. Confirm no third use is intended |
| m-7 | 12.2 | Monthly interpolation requires `monthlySeasonalWeight[0..11]` on every seed template, consistent with the quarterly tuple. That is 12 more calibrated numbers × 12 templates — real M2 content work that only surfaces when reading §12 |
