import { execFileSync } from 'node:child_process';
import { fromDisplay, mulRate, toDisplay, type Money } from '@bizsim/money';
import {
  DEBT_PRODUCTS,
  LEVERAGE_PRICING,
  MIN_OWNER_INJECTION_PCT,
  buildModelFromTemplate,
  collateralValue,
  openingLoanRate,
  underwrite,
  computeMonthZeroOutlays,
  createWorld,
  createWorldConfig,
  tick,
  validateBusinessModel,
} from '@bizsim/engine';
import {
  START_CAPITAL,
  computeConfidenceScore,
  deviationLabel,
  isWellSourced,
  type Archetype,
  type Assumption,
  type BusinessModel,
  type Provenance,
  type ScaleInput,
  type SeedTemplate,
  type WorldState,
} from '@bizsim/schemas';
import { listSeedTemplates } from '@bizsim/seeds';
import {
  reverseChallenge,
  type AdjudicationTransport,
  type ConceptTransport,
} from '@bizsim/llm';
import { argueAssumption, arguableAssumptions } from './argue.js';
import { ask, parseMoney, parseNumber, type LineSource } from './input.js';
import {
  conceptKeyVar,
  conceptPathAvailable,
  runConceptInterview,
  type ConceptResult,
} from './concept.js';
import { capitalIntensityNote, projectFundingGap } from './plausibility.js';
import { openJournal, type Journal } from './journal.js';
import { masthead, note, rule } from './ui.js';

/**
 * Game setup — spec §9.1 Phases 0 through 4.
 *
 * Phase 0 picks starting capital. Phases 1–2 elicit the concept and synthesise a
 * model. Phase 3 puts every assumption in front of the player with its
 * provenance and benchmark band. Phase 4 commits, and only then does the first
 * quarter run.
 *
 * The LLM does Phases 1–2 in M3. What it replaces is the INPUT METHOD, not the
 * phase: it turns "a taco place in Austin" into the same archetype choice and
 * the same parameters this asks for directly, and the engine validates and
 * seeds identically either way. Phases 0, 3 and 4 never needed a model at all.
 *
 * Phase 3 is the part that matters most and the part that had never been built.
 * §10 calls the assumption register the product's differentiator — "build it
 * first-class, not as an afterthought" — and until this screen existed the
 * register was constructed on every run and shown to nobody.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s.padEnd(n));
const rpad = (s: string, n: number): string => s.padStart(n);
const pctText = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * An assumption's value in its own units — never a raw float.
 *
 * The register printed "Credit card processing 0.023799999999999998": the
 * card rate times the card mix, folded at injection, shown with every bit of
 * IEEE 754 noise attached. A rate renders as a percentage, a dollar amount as
 * dollars, and any other number trimmed to what a person would have written.
 */
const assumptionText = (a: Assumption): string => {
  if (typeof a.value === 'bigint') return toDisplay(a.value, { showCents: false });
  if (a.unit === 'pct') return `${Number((a.value * 100).toPrecision(4))}%`;
  return String(Number(a.value.toPrecision(6)));
};

/** §10.3 orders provenance; the colours carry that ordering into the register. */
const PROVENANCE_COLOUR: Record<Provenance, string> = {
  CATALOG: GREEN,
  PLAYER_SOURCED: GREEN,
  BENCHMARK: CYAN,
  CLONED_FROM_PARENT: CYAN,
  LLM_ESTIMATE: YELLOW,
  PLAYER_ASSUMED: RED,
};

const ARCHETYPE_BLURB: Record<Archetype, string> = {
  TRAFFIC: 'physical throughput of a place people walk into',
  UTILIZATION: 'hours of skilled people you can sell',
  UNITS_CAC: 'how much you can spend to acquire a buyer',
  SUBSCRIPTION: 'retaining a paying base over time',
  OCCUPANCY: 'filling a fixed stock of physical units',
  PROJECT_BACKLOG: 'winning and delivering discrete contracts',
};

// ---------------------------------------------------------------------------
// Phase 0 — starting capital
// ---------------------------------------------------------------------------

async function chooseCapital(
  input: LineSource,
): Promise<{ mode: 'LOW' | 'MID' | 'HIGH' | 'FREEPLAY'; custom?: Money }> {
  console.log(`\n${rule('Starting capital')}`);
  console.log(`${DIM}  Everything you have to put at risk.${RESET}`);
  const tier = (n: number, label: string, amount: Money, blurb: string): string =>
    `  ${n}  ${pad(label, 10)}${rpad(toDisplay(amount, { showCents: false }), 12)}  ${DIM}${blurb}${RESET}`;
  console.log(tier(1, 'Low', START_CAPITAL.LOW, 'one location, financed carefully'));
  console.log(tier(2, 'Mid', START_CAPITAL.MID, 'a real build, or a small portfolio'));
  console.log(tier(3, 'High', START_CAPITAL.HIGH, 'a project that needs a capital stack'));
  console.log(`  4  ${pad('Custom', 10)}${DIM}free play, capped at $1B${RESET}`);

  const choice = await ask(input, '> ', 2, (raw) => {
    const n = parseNumber(raw);
    return n !== undefined && n >= 1 && n <= 4 ? n : undefined;
  });

  if (choice === 1) return { mode: 'LOW' };
  if (choice === 2) return { mode: 'MID' };
  if (choice === 3) return { mode: 'HIGH' };
  const custom = await ask(input, '  How much? ', START_CAPITAL.MID, parseMoney);
  return { mode: 'FREEPLAY', custom };
}


// ---------------------------------------------------------------------------
// Phases 1–2 — concept and synthesis, structured
// ---------------------------------------------------------------------------

async function chooseTemplate(input: LineSource): Promise<SeedTemplate> {
  const templates = listSeedTemplates();
  console.log(`\n${rule('What are you building?')}`);
  templates.forEach((t, i) => {
    const archetype = t.defaultArchetypes[0]!;
    console.log(
      `  ${i + 1}  ${pad(t.label, 28)}${DIM}${pad(archetype, 17)}${ARCHETYPE_BLURB[archetype]}${RESET}`,
    );
  });
  console.log(
    `\n${DIM}  The archetype is chosen by the BINDING CONSTRAINT (§3.8), not by industry.${RESET}`,
  );

  const pick = await ask(input, '> ', 1, (raw) => {
    const n = parseNumber(raw);
    return n !== undefined && n >= 1 && n <= templates.length ? n : undefined;
  });
  return templates[pick - 1]!;
}

interface ScaleField {
  key: Extract<keyof ScaleInput, string>;
  label: string;
  money?: boolean;
  fallback: number;
  band?: string;
}

/** The scale knobs that matter, per archetype. */
function scaleFields(template: SeedTemplate, archetype: Archetype): ScaleField[] {
  const d = template.streamParamDefaults;
  const num = (k: string, f: number): number => (typeof d[k] === 'number' ? (d[k] as number) : f);

  switch (archetype) {
    case 'TRAFFIC':
      return [
        { key: 'seats', label: 'Seats', fallback: num('seats', 60) },
        { key: 'turnsPerDay', label: 'Turns per day', fallback: num('turnsPerDay', 2), band: '1.2–3.0' },
        { key: 'addressableTrafficPerQuarter', label: 'Trade-area traffic per quarter', fallback: num('addressableTrafficPerQuarter', 150_000) },
        { key: 'captureRate', label: 'Capture rate (as a %)', fallback: num('captureRate', 0.04) * 100, band: '2–8%' },
        { key: 'price', label: 'Average ticket', money: true, fallback: num('avgTicket', 30) },
        { key: 'skuCount', label: 'Distinct items offered', fallback: num('skuCount', 40), band: 'more slows service' },
      ];
    case 'UTILIZATION':
      return [
        { key: 'demandHoursPerQuarter', label: 'Billable hours the market wants per quarter', fallback: num('demandHoursPerQuarter', 4_000) },
        { key: 'price', label: 'Blended hourly rate', money: true, fallback: num('blendedHourlyRate', 150) },
      ];
    case 'UNITS_CAC':
      return [{ key: 'price', label: 'Average order value', money: true, fallback: num('avgOrderValue', 85) }];
    case 'SUBSCRIPTION':
      return [{ key: 'price', label: 'Revenue per customer per quarter', money: true, fallback: num('arpuPerQuarter', 300) }];
    case 'OCCUPANCY':
      return [
        { key: 'units', label: 'Units', fallback: num('units', 500) },
        { key: 'price', label: 'Rate per unit per quarter', money: true, fallback: num('ratePerUnitPerQuarter', 330) },
      ];
    case 'PROJECT_BACKLOG':
      return [
        { key: 'bidsSubmittedPerQuarter', label: 'Bids submitted per quarter', fallback: num('bidsSubmittedPerQuarter', 9) },
        { key: 'price', label: 'Average contract value', money: true, fallback: num('avgContractValue', 320_000) },
        { key: 'executionCapacityPerQuarter', label: 'Work the crew can complete per quarter', money: true, fallback: num('executionCapacityPerQuarter', 700_000) },
      ];
  }
}

async function askScale(
  input: LineSource,
  template: SeedTemplate,
  archetype: Archetype,
): Promise<ScaleInput> {
  console.log(`\n${rule('Scale')}`);
  console.log(`${DIM}  Enter to accept the seeded default.${RESET}`);
  const scale: Record<string, unknown> = {};

  for (const field of scaleFields(template, archetype)) {
    const shown = field.money
      ? toDisplay(fromDisplay(field.fallback), { showCents: false })
      : field.fallback.toLocaleString();
    const band = field.band ? ` ${DIM}band ${field.band}${RESET}` : '';
    const prompt = `  ${pad(field.label, 42)}[${shown}]${band}: `;

    if (field.money) {
      const value = await ask(input, prompt, fromDisplay(field.fallback), parseMoney);
      scale[field.key] = value;
    } else {
      const value = await ask(input, prompt, field.fallback, parseNumber);
      // captureRate is entered as a percentage because nobody thinks in 0.05.
      scale[field.key] = field.key === 'captureRate' ? value / 100 : value;
    }
  }
  return scale as ScaleInput;
}

// ---------------------------------------------------------------------------
// Phase 3 — assumption review
// ---------------------------------------------------------------------------

/** Wrap to the register's own width; the questions run long by design. */
function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join(`\n${indent}`);
}

function renderRegister(model: BusinessModel): void {
  const assumptions = model.assumptions;
  const byId: Record<string, Assumption> = {};
  for (const a of assumptions) byId[a.id] = a;
  const confidence = computeConfidenceScore({ byId, byPath: {}, confidenceScore: 0 });

  const counts: Partial<Record<Provenance, number>> = {};
  for (const a of assumptions) counts[a.provenance] = (counts[a.provenance] ?? 0) + 1;

  // Ordered by how far out, not by where they happen to sit in the register:
  // a rent 1.1x the top of its range and a ticket price 22x are both "out of
  // band", and only one of them is worth a founder's attention first (D-5).
  const outOfBand = assumptions
    .filter((a) => a.outsideBenchmark)
    .sort((a, b) => Math.abs(b.benchmarkDeviation ?? 0) - Math.abs(a.benchmarkDeviation ?? 0));
  const weak = assumptions.filter((a) => !isWellSourced(a.provenance));

  console.log(`\n${BOLD}ASSUMPTIONS${RESET}  ${assumptions.length} registered`);
  console.log(
    `${DIM}Every number the engine uses has a record here. That is the point (§10.2):${RESET}\n` +
      `${DIM}a model whose inputs cannot be traced is not one you can take to a lender.${RESET}`,
  );

  const confidenceColour = confidence >= 0.5 ? GREEN : confidence >= 0.2 ? YELLOW : RED;
  console.log(
    `\n  Model confidence  ${confidenceColour}${pctText(confidence)}${RESET}` +
      `  ${DIM}share of assumptions you have actually sourced${RESET}`,
  );
  const summary = (Object.keys(counts) as Provenance[])
    .sort()
    .map((p) => `${PROVENANCE_COLOUR[p]}${p} ${counts[p]}${RESET}`)
    .join(`${DIM} · ${RESET}`);
  console.log(`  ${summary}`);

  if (outOfBand.length > 0) {
    console.log(
      `\n  ${YELLOW}${outOfBand.length} ` +
        `${outOfBand.length === 1 ? 'is outside its' : 'are outside their'} benchmark band:${RESET}`,
    );
    for (const a of outOfBand.slice(0, 8)) {
      const value = assumptionText(a);
      const band = a.benchmarkBand;
      const magnitude = deviationLabel(a);
      console.log(
        `    ${pad(a.label, 34)}${rpad(value, 12)}  ${YELLOW}${rpad(magnitude ?? '', 26)}${RESET}` +
          `${DIM}band ${band?.low}–${band?.high} · ${band?.source ?? ''}${RESET}`,
      );
    }
    /**
     * §11.3.1 — the register as a reviewer rather than a log.
     *
     * Founders are usually most wrong on the cost side: understated labour,
     * forgotten maintenance, no owner salary, missing insurance. Deterministic
     * on purpose — §10.5 is explicit that the out-of-band check is engine logic
     * and not model judgement, so the question it raises is built from the same
     * arithmetic and has nothing to fabricate.
     */
    for (const a of outOfBand.slice(0, 3)) {
      const asked = reverseChallenge({
        label: a.label,
        value: Number(a.isMoney ? Number(a.value) / 100 : a.value),
        unit: a.unit,
        ...(a.benchmarkBand ? { benchmarkBand: a.benchmarkBand } : {}),
        sourceNote: a.sourceNote,
      });
      if (asked) console.log(`\n  ${YELLOW}? ${wrapText(asked, 74, '    ')}${RESET}`);
    }
  }

  // PLAYER_ASSUMED ranks BELOW the model's own estimate (§10.3): an unsupported
  // assertion by an optimistic founder is the least reliable input in the system.
  const assumed = weak.filter((a) => a.provenance === 'PLAYER_ASSUMED');
  if (assumed.length > 0) {
    /**
     * Singular when there is one of them.
     *
     * "1 are your assertions with no evidence behind them" is the sort of line
     * that quietly tells a reader nobody looked at this screen — which is the
     * opposite of what a register is for.
     */
    console.log(
      `\n  ${RED}${assumed.length} ` +
        (assumed.length === 1
          ? 'is your assertion with no evidence behind it:'
          : 'are your assertions with no evidence behind them:') +
        `${RESET}`,
    );
    for (const a of assumed.slice(0, 6)) {
      const value = assumptionText(a);
      console.log(`    ${pad(a.label, 34)}${rpad(value, 12)}  ${DIM}${a.sourceNote}${RESET}`);
    }
  }
}

/**
 * What the first quarter will actually take out, before any revenue lands.
 *
 * Ticking the candidate world once, which is free: the engine is pure and this
 * world is a throwaway. Cheaper than a rule of thumb and exactly right, which
 * a rule of thumb was not — see `renderOpening`.
 */
/**
 * Quarters of room below which opening is thin.
 *
 * One and a half rather than one: a business funded to exactly its first
 * quarter opens the second one on the revolver, and the second quarter is
 * usually worse than the first because the ramp has not arrived yet.
 */
export const THIN_QUARTERS = 1.5;

/**
 * Thin measured against the burn, not against a round number.
 *
 * This was `cash < $50,000`. A cafe opened with $50,952 — over the line by
 * nine hundred dollars — into a first quarter that took $148,000 out, and the
 * screen said nothing at all. A pawn shop before it opened with $13,084 and
 * got the warning, which made the flat threshold look like it worked.
 *
 * $50,000 is a year of slack for a food truck and three weeks for a cafe. The
 * only figure that means anything is how long the cash lasts.
 */
export const isThin = (cash: Money, firstQuarterBurn: Money): boolean =>
  firstQuarterBurn > 0n && Number(cash) / Number(firstQuarterBurn) < THIN_QUARTERS;

/**
 * The equity that brings a deal's debt share down to `share`, fee-grossed.
 *
 * The loan that fills the gap is (needed − e)/(1 − f), so
 * loan/(loan + e) ≤ s solves to e ≥ needed·(1 − s) / (s·(1 − f) + 1 − s).
 * This is the number behind "putting in $X more prices the loan lower" — a
 * hint is only useful if the figure it names actually lands in the tier.
 */
export { equityForShare } from './funding.js';
import { equityForShare } from './funding.js';

function firstQuarterBurn(world: WorldState): Money {
  const result = tick(world, [], { throwOnAssertionFailure: false });
  const cf = result.statements.byBusiness[world.businesses[0]!.id]?.cashFlow;
  const ops = cf?.cashFlowFromOperations ?? 0n;
  return ops < 0n ? -ops : 0n;
}

/**
 * Arguing with a number, before it is frozen — §11.3.
 *
 * This is the loop the register was built for. Everything else in Phase 3 shows
 * the player what their model rests on; this is where they get to push back,
 * and where pushing back has to cost something more than saying so.
 *
 * The adjudication runs in isolation — the transport sends the assumption and
 * the claim in a single message with no history, because rapport is what
 * produces capitulation. And the two rules pressure attacks are settled in code
 * before the model's ruling is applied at all: a bare assertion reaches the
 * near edge of its range and stops, and an impossible value is refused however
 * good the evidence sounds.
 */
async function challengeLoop(
  input: LineSource,
  model: BusinessModel,
  transport?: ConceptTransport,
): Promise<string | undefined> {
  // Selection shared with the web register — docs in `arguableAssumptions`.
  const arguable = arguableAssumptions(model.assumptions);
  if (arguable.length === 0) return undefined;

  console.log(
    `\n  ${DIM}\`challenge <n> <value> [why]\` argues with one of these. A bare number moves it` +
      ` at most to the\n  edge of its range; a real basis — a quote, a listing, a model number —` +
      ` moves it properly.\n  Plain words work too: say what should change about the business` +
      ` itself and the model redrafts it.${RESET}`,
  );
  arguable.forEach((a, i) => {
    const value = assumptionText(a);
    console.log(`    ${rpad(String(i + 1), 3)}  ${pad(a.label, 38)}${rpad(value, 12)}  ${DIM}${a.provenance}${RESET}`);
  });

  while (true) {
    const raw = await input.next('\n  challenge, or enter to move on > ');
    if (raw === undefined || raw.trim() === '') return undefined;
    const [verb = '', indexToken = '', valueToken = '', ...basisWords] = raw.trim().split(/\s+/);
    if (verb.toLowerCase() !== 'challenge') {
      /**
       * Prose at a numbers prompt is an objection, not a typo.
       *
       * "wait, I don't want to lease I want to buy the planes used at a good
       * price" — typed here, answered with a canned `challenge 3 22000` hint,
       * and lost. A structural change is a drafting question the register
       * cannot express, so it is handed back to the caller, who re-enters the
       * interview with it. The three-word floor keeps a mistyped verb from
       * triggering an expensive redraft.
       */
      if (raw.trim().split(/\s+/).length >= 3) return raw.trim();
      console.log(
        `  ${DIM}\`challenge 3 22000 used unit on MachineryTrader\` argues with a number — or` +
          ` say in plain words\n  what should change about the business itself, and the model` +
          ` redrafts it.${RESET}`,
      );
      continue;
    }

    const index = Number(indexToken);
    const target = Number.isInteger(index) ? arguable[index - 1] : undefined;
    if (!target) {
      console.log(`  ${RED}Which one? 1 to ${arguable.length}.${RESET}`);
      continue;
    }
    const asserted = target.isMoney ? parseMoney(valueToken) : parseNumber(valueToken);
    if (asserted === undefined) {
      console.log(`  ${RED}That is not a number.${RESET}`);
      continue;
    }

    const basis = basisWords.join(' ').trim();
    const outcome = await argueAssumption({
      transport: transport ? adjudicationOf(transport) : undefined,
      target,
      writeTo: model,
      asserted: asserted as number | bigint,
      basis,
      archetype: model.streams[0]?.archetype ?? 'TRAFFIC',
      businessName: model.businessName,
    });
    const settled = outcome.settlement;

    console.log(`  ${RULING_COLOUR[settled.ruling]}${settled.ruling}${RESET}  ${wrapText(settled.reasoning, 70, '        ')}`);
    if (settled.clarifyingQuestion) {
      console.log(`  ${CYAN}? ${wrapText(settled.clarifyingQuestion, 70, '    ')}${RESET}`);
    }
    if (settled.secondOrderEffect) {
      console.log(`  ${DIM}↳ ${wrapText(settled.secondOrderEffect, 70, '    ')}${RESET}`);
    }

    if (outcome.pathBroken) {
      console.log(`  ${RED}${target.label} is registered at ${target.path}, which no longer resolves.${RESET}`);
      continue;
    }
    if (!outcome.applied) continue;
    const landed = outcome.resultingValue;
    console.log(
      `  ${DIM}${target.label} → ${target.isMoney ? toDisplay(landed as bigint, { showCents: false }) : landed}` +
        ` · ${settled.provenance}${settled.clamped ? ' (held at the edge of its range)' : ''}${RESET}`,
    );
  }
}

const RULING_COLOUR: Record<string, string> = {
  CONCEDE: GREEN,
  PARTIAL: YELLOW,
  DEFEND: RED,
  NEED_CLARIFICATION: CYAN,
};

/** The transport, narrowed to the one method the contract is allowed to use. */
const adjudicationOf = (transport: ConceptTransport): AdjudicationTransport => ({
  adjudicate: (system, input) => transport.adjudicate(system, input),
});

/**
 * What to call the capex line, from what is actually in it.
 *
 * It was hardcoded to "Buildout & equipment", which is the restaurant's word —
 * the same reflex that told a concrete plant it needed twelve covers a day. A
 * mobile game studio was shown "$5,000 Buildout & equipment" for what the draft
 * had described as a development machine, and the honest reaction to that is
 * the one it got: a software company does not do buildout.
 *
 * Driven off `category`, which the draft already sets, so this stays right for
 * a business nobody has thought of yet rather than for the six in the seed set.
 */
function capexLabel(model: BusinessModel): string {
  const categories = new Set(model.capex.map((c) => c.category));
  if (categories.has('REAL_PROPERTY')) return 'Property, buildout & equipment';
  if (categories.has('LEASEHOLD_IMPROVEMENTS')) return 'Buildout & equipment';
  if (categories.has('VEHICLES')) {
    return categories.size > 1 ? 'Vehicles & equipment' : 'Vehicles';
  }
  if (categories.has('FF&E')) {
    return categories.has('EQUIPMENT') ? 'Equipment & fittings' : 'Fittings & furniture';
  }
  return 'Equipment';
}

function renderOpening(model: BusinessModel, world: WorldState): void {
  const outlays = computeMonthZeroOutlays(model);
  const business = world.businesses[0]!;

  console.log(`\n${BOLD}MONTH ZERO${RESET}  ${DIM}— cash out before you serve a single customer (§5.4)${RESET}`);
  const rows: [string, Money][] = [
    ['Lease signing (first + last + deposit)', outlays.leaseSigning],
    [capexLabel(model), outlays.buildoutAndEquipment],
    ['Opening inventory', outlays.initialInventory],
    ['Permits & legal', outlays.permitsAndLegal],
    ['Prepaid insurance', outlays.prepaidInsurance],
    ['Pre-opening payroll & training', outlays.preOpeningPayroll],
    ['Pre-opening marketing', outlays.preOpeningMarketing],
    ['Debt origination fees', outlays.debtOriginationFees],
    ['Revolver commitment fee', outlays.revolverCommitmentFees],
  ];
  for (const [label, value] of rows) {
    if (value === 0n) continue;
    console.log(`  ${pad(label, 42)}${rpad(toDisplay(value), 16)}`);
    // What the capex line is actually made of. "$5,000 of buildout" on a
    // mobile game studio is a figure nobody can argue with because nobody can
    // tell what it is; the draft named every item and the screen was throwing
    // the names away.
    if (label === capexLabel(model)) {
      /**
       * Largest first, and line totals rather than per-unit costs.
       *
       * In draft order, a $4M month zero showed a $400k building, $150k of
       * fit-out, $154k of machines and $20k of security — and hid a single
       * $3.26M item behind "…and 1 more". The player committed 80% of their
       * capital to a line they never saw. Whatever gets truncated must be
       * the smallest, and the tail says what it adds up to so a big remainder
       * cannot hide in a count.
       */
      const items = model.capex
        .map((item) => ({ item, total: mulRate(item.grossCost, item.quantity) }))
        .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
      for (const { item, total } of items.slice(0, 4)) {
        const each = item.quantity > 1 ? ` × ${item.quantity}` : '';
        console.log(
          `    ${DIM}${pad(item.label + each, 40)}${toDisplay(total, { showCents: false })}${RESET}`,
        );
      }
      if (items.length > 4) {
        const rest = items.slice(4).reduce<Money>((a, i) => a + i.total, 0n);
        console.log(
          `    ${DIM}…and ${items.length - 4} more, ${toDisplay(rest, { showCents: false })} together${RESET}`,
        );
      }
    }
  }
  console.log(`  ${BOLD}${pad('TOTAL', 42)}${rpad(toDisplay(outlays.total), 16)}${RESET}`);

  const equity = model.financingPlan.equityInjection;
  // A revolver is a limit, not a drawdown — `openBusiness` sets its outstanding
  // principal to zero. Adding it here produced "you borrow $100,000" directly
  // above an opening cash figure that did not include a cent of it.
  const termDebt = model.financingPlan.debtRequests
    .filter((d) => d.kind !== 'REVOLVER')
    .reduce<Money>((a, d) => a + d.requestedPrincipal, 0n);
  const revolverLimit = model.financingPlan.debtRequests
    .filter((d) => d.kind === 'REVOLVER')
    .reduce<Money>((a, d) => a + d.requestedPrincipal, 0n);
  const outside = model.financingPlan.outsideCapital;
  console.log(
    termDebt > 0n
      ? `\n  You put in ${BOLD}${toDisplay(equity)}${RESET} and borrow ${BOLD}${toDisplay(termDebt)}${RESET}.`
      : `\n  You put in ${BOLD}${toDisplay(equity)}${RESET}, all of it your own.`,
  );
  if (outside > 0n) {
    console.log(
      note(
        `${toDisplay(outside, { showCents: false })} comes from outside the deal — a credit, a` +
          ` grant or a partner. It is equity in the business and does not come out of your pocket,` +
          ` but it is somebody's money and it dilutes what the business is worth to you.`,
      ),
    );
  }
  if (revolverLimit > 0n) {
    console.log(
      note(
        `A ${toDisplay(revolverLimit, { showCents: false })} revolver stands behind it, undrawn —` +
          ` it costs its fee at close and lends only when you are short.`,
      ),
    );
  }
  const cashColour = business.cash <= 0n ? RED : business.cash < fromDisplay(50_000) ? YELLOW : GREEN;
  console.log(`  Opening cash        ${cashColour}${toDisplay(business.cash)}${RESET}`);
  // Still shown, because money you did not put in is money you still have and
  // can `inject` later. It just no longer drains on its own.
  console.log(`  Kept back           ${toDisplay(world.household.cash)}`);

  // Zero is fundable and still precarious, and the two are different messages.
  // Warning "you cannot afford to open" and then opening anyway is the kind of
  // contradiction that teaches a player to ignore the screen.
  if (business.cash === 0n) {
    console.log(
      `\n  ${YELLOW}Funded to the cent and no further: the first quarter's costs land` +
        ` before its revenue does, so this opens straight onto the revolver.${RESET}`,
    );
  }

  if (business.cash < 0n) {
    console.log(
      `\n  ${RED}You cannot afford to open. Raise more equity or debt, or build something smaller.${RESET}`,
    );
    return;
  }

  /**
   * Thin measured against the burn, not against a round number.
   *
   * This was `cash < $50,000`. A café opened with $50,952 — over the line by
   * nine hundred dollars — into a first quarter that took $148,000 out, and
   * the screen said nothing at all. The pawn shop before it opened with
   * $13,084 and got the warning, which made the threshold look like it worked.
   *
   * $50,000 is a lot of money for a food truck and three weeks for a café.
   * The only figure that means anything here is how long the cash lasts, and
   * the engine can simply be asked.
   */
  const burn = firstQuarterBurn(world);
  if (burn > 0n) {
    const quarters = Number(business.cash) / Number(burn);
    if (isThin(business.cash, burn)) {
      console.log(
        `\n  ${YELLOW}That is thin: ${toDisplay(business.cash, { showCents: false })} of cash against` +
          ` a first quarter that takes ${toDisplay(burn, { showCents: false })} out before revenue` +
          ` covers anything — about ${quarters.toFixed(1)} quarters of room.${RESET}`,
      );
      console.log(
        note(
          'Month zero is not the peak. The peak comes when you are open and still losing money,' +
            ' and that is the number to fund against.',
        ),
      );
    }
  }

  /**
   * And then say what that number is.
   *
   * The line above told a ready-mix operator that the peak is what to fund
   * against, and did not tell him what the peak was. He opened with $989,000
   * raised against a plan that needed $1.6M by its third quarter, and was
   * insolvent inside a year with $1.3M of personally guaranteed debt following
   * him home. Every term was computable at this screen.
   *
   * Projected with the crisis ladder switched off, because a projection that
   * lets emergency debt at 19.5% rescue each quarter answers "can this be kept
   * alive" — a different and much less useful question than "what does it
   * need".
   */
  const raised =
    model.financingPlan.equityInjection +
    model.financingPlan.outsideCapital +
    model.financingPlan.debtRequests.reduce<Money>((a, d) => a + d.requestedPrincipal, 0n);
  const gap = projectFundingGap(world, raised);
  if (gap && gap.shortfall > 0n) {
    console.log(
      `\n  ${RED}Run forward, this plan is down ${toDisplay(gap.peak, { showCents: false })} at its ` +
        `worst — period ${gap.atPeriod} — against the ${toDisplay(gap.raised, { showCents: false })} ` +
        `you have raised. It is short by ${toDisplay(gap.shortfall, { showCents: false })}.${RESET}`,
    );
    console.log(
      note(
        'That gap gets funded by the crisis ladder if you open anyway: the revolver first, then' +
          ' factored receivables, then emergency debt at prime plus twelve with your name on it.' +
          ' More equity or a bigger loan now is the same money at a fifth of the price.',
      ),
    );
  } else if (gap) {
    console.log(
      `\n  ${DIM}Run forward, this plan is down ${toDisplay(gap.peak, { showCents: false })} at its ` +
        `worst — period ${gap.atPeriod} — inside the ${toDisplay(gap.raised, { showCents: false })} ` +
        `you have raised.${RESET}`,
    );
  }
}

// ---------------------------------------------------------------------------

export interface SetupResult {
  /** Where this session was recorded, for the caller to keep writing to. */
  journal?: Journal;
  world: WorldState;
  committed: boolean;
}

export interface RunSetupOptions {
  /** Injected in tests so the whole flow runs without a key or a network. */
  transport?: ConceptTransport;
  /** Injected in tests so nothing is written to disk. */
  journal?: Journal;
}

/**
 * The build this run came from, so a recorded session says what produced it.
 *
 * The same reasoning as the masthead stamp: three sessions running were
 * diagnosed by inferring the build from which corruption got through, and a
 * journal without it would make that worse at scale rather than better.
 */
function buildSha(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

export async function runSetup(
  input: LineSource,
  options?: RunSetupOptions,
): Promise<SetupResult | undefined> {
  console.log(masthead());
  const journal = options?.journal ?? openJournal('setup');
  journal.write({
    kind: 'session',
    build: buildSha(),
    startedAt: new Date().toISOString(),
    startCapital: '',
  });

  const capital = await chooseCapital(input);

  // Phases 1-2. The conversation is the intended path; the picker is what you
  // get when there is no model to talk to, not a co-equal alternative.
  let template: SeedTemplate;
  let archetype: Archetype;
  let scale: ScaleInput;
  let businessName: string;
  let concept: ConceptResult | undefined;

  if (options?.transport || conceptPathAvailable()) {
    const startAmount =
      capital.custom ?? (capital.mode === 'FREEPLAY' ? START_CAPITAL.MID : START_CAPITAL[capital.mode]);
    concept = await runConceptInterview(
      input,
      options?.transport,
      journal,
      toDisplay(startAmount, { showCents: false }),
    );
    if (!concept) return undefined;
    template = concept.mapped.template;
    archetype = concept.mapped.archetype;
    scale = concept.mapped.scale;
    businessName = concept.mapped.businessName;
  } else {
    console.log(
      `\n${DIM}  No ${conceptKeyVar()}, so the conversational path is unavailable and this${RESET}\n` +
        `${DIM}  falls back to picking a template. Set the key to describe a business in${RESET}\n` +
        `${DIM}  your own words instead.${RESET}`,
    );
    template = await chooseTemplate(input);
    archetype = template.defaultArchetypes[0]!;
    scale = await askScale(input, template, archetype);
    businessName = template.label;
  }

  /**
   * Marketing is not asked for, and that is the fix rather than an omission.
   *
   * "The user doesn't know an appropriate amount of marketing spend per
   * quarter" — correct, and neither does anything else at this point in the
   * flow. The figure came out of the draft, where it was reasoned about
   * alongside the rest of the business. Asking the player to confirm a number
   * they have no basis for is an intake form pretending to be a decision.
   *
   * It is not locked: `marketing 12k` changes it in any quarter, with a P&L on
   * screen and the response curve visible in the last quarter's revenue. That
   * is where the call can actually be made.
   */
  // (moved into the pricing loop below — the template can change on reopen)

  /**
   * Which decade of market history this run gets.
   *
   * The engine cannot read a clock (§1.3), so the seed is chosen out here and
   * handed in — every price in the run is then a pure function of it, and the
   * same seed replays the same decade exactly. Varying it per run matters: a
   * constant would mean every player who ever bought the index lived through
   * the identical crash, and the benchmark would stop being a benchmark and
   * start being a fixed opponent.
   */
  const marketSeed = Date.now() % 1_000_000_007;
  journal.write({ kind: 'market_seed', seed: marketSeed });

  const config = createWorldConfig(
    capital.custom !== undefined
      ? { startMode: capital.mode, customCapital: capital.custom, marketSeed }
      : { startMode: capital.mode, marketSeed },
  );

  /**
   * Financing is asked in a loop, and the loop is the point.
   *
   * The gate below used to end the run: five turns of conversation, a drafted
   * business, and then "you are short by $60,000 — run `pnpm sim --new`
   * again", which throws the whole concept away over a number the player would
   * happily have changed. Nothing upstream of this depends on the financing, so
   * there was never a reason to discard it; the shortfall is information, not a
   * verdict.
   *
   * Bounded rather than open, because `ask` returns its default at end of
   * input: a piped transcript that runs out mid-gate would otherwise re-ask
   * itself, take the same defaults, and fail identically until the process died.
   */
  const MAX_FINANCING_ATTEMPTS = 4;
  let model: BusinessModel | undefined;
  let world: WorldState | undefined;

  /**
   * All of it is investable. There is no living reserve.
   *
   * There used to be $60,000 held back, on the reasoning that §2.3 draws
   * living expenses from household cash and a founder who put in every dollar
   * is personally insolvent by the second quarter. That reasoning is sound and
   * the feature was still wrong: it took 60% of a $100,000 start off the table
   * before the player had made a single decision, and then the game explained
   * why their ice cream shop was unfundable. Personal solvency is a different
   * game from the one this is, and modelling both made the interesting one
   * harder to reach.
   *
   * The household draw is off with it — see `createWorld` below. Half a
   * decision would be worse than either whole one: a reserve of zero against a
   * household that still bleeds is precisely the bankruptcy the reserve
   * existed to prevent.
   */
  const investable = config.startCapital;

  /**
   * Everything from financing to the challenge gate runs in a loop.
   *
   * The challenge prompt can hand back a *structural* objection — "I want to
   * buy the planes, not lease them" — which no assumption edit can express.
   * That goes back into the interview through `reopen`, a fresh draft comes
   * back, and pricing starts over: month zero, the funding plan and the
   * register are all downstream of the draft, so all of them are recomputed.
   */
  for (;;) {
    const marketing = template.modifierDefaults.baseMarketingSpendPerQuarter;
    for (let attempt = 1; ; attempt++) {
      // What opening costs, before anyone has been asked for a number. Everything
      // below is arithmetic on this, which is the whole point: the player is
      // being shown a plan, not interrogated for its inputs.
      const bare = buildModelFromTemplate({
        businessName,
        template,
        archetype,
        scale,
        marketingSpendPerQuarter: marketing,
        equityInjection: 0n,
        ...(concept ? { provenanceFor: concept.mapped.provenanceFor } : {}),
      });
      // Opened, so the assets exist to lend against. Nothing is committed by
      // this: it is the same throwaway probe the outlay figure comes from.
      const bareWorld = createWorld({
        id: 'probe',
        playerId: 'probe',
        config,
        annualLivingExpenses: 0n,
        models: [bare],
      });
      const monthZero = computeMonthZeroOutlays(bare).total;
      // Month zero alone is a knife edge: the first quarter's fixed costs land
      // before any revenue does, so a business funded to exactly its opening
      // outlay begins on the crisis ladder. One quarter of fixed operating cost
      // on top — the buffer a lender would expect to see anyway.
      const quarterOfFixed = bare.costs.fixedPeriod.reduce<Money>(
        (a, c) => a + c.amountPerQuarter,
        0n,
      );
      const needed = monthZero + quarterOfFixed;

      /**
       * Propose a round number with room in it, not the bare minimum.
       *
       * The old proposal was month zero plus exactly one quarter of fixed
       * costs — a knife edge. Most businesses take several quarters to reach
       * profitability, so a player who took the suggestion opened the second
       * quarter on the revolver and read it as their plan failing rather than
       * their funding being thin. Round up to the nearest $1M when they have
       * $1M+ to invest, the nearest $100k below that, and cap at everything
       * they have when rounding would exceed it. The excess is opening cash,
       * which is the cheapest runway there is.
       */
      const unit = investable >= fromDisplay(1_000_000) ? fromDisplay(1_000_000) : fromDisplay(100_000);
      const roundedNeed = ((needed + unit - 1n) / unit) * unit;
      const proposedEquity = roundedNeed < investable ? roundedNeed : investable;
      const gap = needed > proposedEquity ? needed - proposedEquity : 0n;
      // Grossed up for the fee, because a loan does not deliver its own
      // principal: SBA 7(a) charges 3% at close, so borrowing exactly the gap
      // lands 3% short. This is what left an earlier run one origination fee
      // outside a gate the setup had just recommended.
      const originationPct = DEBT_PRODUCTS.SBA_7A.originationFeePct;
      const wanted = gap > 0n ? mulRate(gap, 1 / (1 - originationPct)) : 0n;

      /**
       * Propose only what a lender will actually write.
       *
       * The screen offered "$40,000 of your own plus a $113,925 SBA 7(a)" and
       * the lender declined it on the very next screen — $113,925 against
       * $61,800 of collateral. Recommending a plan and then refusing it is the
       * same self-contradiction as the commit gate rejecting a build the setup
       * had just suggested, and it teaches the player that the numbers on offer
       * are not real.
       *
       * Two ceilings, both the underwriter's own: lending value of the assets,
       * and ten times the owner's injection. The collateral is *shared* — the
       * engine underwrites each facility against the full amount independently,
       * so proposing both at the ceiling would slip two loans through a test
       * meant to allow one. The term loan takes priority and the revolver gets
       * what is left, because the term loan is what actually funds opening.
       */
      const lendable = collateralValue(bareWorld.businesses[0]!);
      const onEquity = mulRate(proposedEquity, 1 / MIN_OWNER_INJECTION_PCT);
      const ceiling = lendable < onEquity ? lendable : onEquity;
      const proposedLoan = wanted < ceiling ? wanted : ceiling;
      const headroom = ceiling > proposedLoan ? ceiling - proposedLoan : 0n;
      const revolverTarget = fromDisplay(100_000);
      const proposedRevolver = headroom < revolverTarget ? headroom : revolverTarget;

      let loan: Money;
      let revolver: Money;
      let equity: Money;
      let outside = 0n;

      /**
       * One choice instead of three numbers.
       *
       * The old screen asked for an SBA loan, a revolver limit and an equity
       * injection as bare dollar figures. Nobody arrives at a terminal knowing
       * what revolver limit a veggie burger place should carry, and the
       * arithmetic that answers it — month zero, a quarter of fixed costs, the
       * origination fee, what is left after living expenses — is all already
       * computed right here. Asking was never eliciting information; it was
       * making the player do the sum by hand and then refusing them when they
       * got it wrong.
       *
       * The numbers are still fully editable. What changed is that the default
       * is a worked plan rather than a blank field.
       */
      console.log(`\n${rule('Funding')}`);
      console.log(
        note(
          `Opening costs ${toDisplay(needed, { showCents: false })} — buildout, deposits and` +
            ` the first quarter of fixed costs before any revenue lands.`,
        ),
      );
      console.log(
        note(
          `You have ${toDisplay(config.startCapital, { showCents: false })}, all of it` +
            ` available to put into this.`,
        ) + '\n',
      );
      const plan =
        proposedLoan > 0n
          ? `${toDisplay(proposedEquity, { showCents: false })} of your own plus a ` +
            `${toDisplay(proposedLoan, { showCents: false })} SBA 7(a)`
          : `${toDisplay(proposedEquity, { showCents: false })} of your own, no debt needed`;
      /**
       * Never offer a plan that does not fund the build.
       *
       * A Nevada solar farm was offered "$1,000,000 of your own plus a
       * $3,000,000 SBA 7(a)" against a $5.19M opening cost, chose it, and was
       * refused one screen later — short by $1.192M. The proposal already
       * respects the lending ceiling; what it did not do was notice that the
       * capped plan cannot cover opening, and say so before the choice rather
       * than after it.
       */
      const proposedTotal = proposedEquity + proposedLoan;
      const shortBy = needed > proposedTotal ? needed - proposedTotal : 0n;

      console.log(
        shortBy > 0n
          ? `  1  ${plan} — ${RED}still ${toDisplay(shortBy, { showCents: false })} short${RESET}`
          : proposedRevolver > 0n
            ? `  1  ${plan}, and a ${toDisplay(proposedRevolver, { showCents: false })} revolver`
            : `  1  ${plan}`,
      );
      console.log(`  2  ${DIM}Set the loan, revolver and equity myself${RESET}`);
      if (shortBy > 0n) {
        console.log(
          note(
            `That is everything a lender will write against this build plus everything you have.` +
              ` Closing the gap takes money from outside the deal — a tax credit, a grant, a` +
              ` partner — or a smaller project. Option 2 asks for outside capital as well.`,
          ),
        );
      }

      const choice = await ask(input, '> ', 1, (raw) => {
        const n = parseNumber(raw);
        return n === 1 || n === 2 ? n : undefined;
      });

      if (choice === 1) {
        loan = proposedLoan;
        revolver = proposedRevolver;
        equity = proposedEquity;
      } else {
        /**
         * One number: the equity. The loan, its rate and the revolver follow.
         *
         * The old form asked for a term loan, a revolver limit and an equity
         * figure as three blank fields, then let the lender refuse the
         * combination two screens later. Nobody arrives knowing a revolver
         * limit; the decision a founder actually owns is how much of their own
         * money goes in, and everything else is arithmetic this screen already
         * has. The rate moves with leverage (`LEVERAGE_PRICING`), so more
         * equity genuinely buys a cheaper loan — the trade this conversation
         * exists to surface.
         *
         * Outside money — the line the solar farm had nowhere to put (its
         * stack was $1.0M sponsor equity, ~$1.5M of transferred ITC, ~$3.2M of
         * debt) — folds into the same question: anything above what the
         * player has is a grant, a credit or a partner by definition.
         */
        const grossFee = 1 / (1 - originationPct);
        // The smallest equity a lender will cover the rest of: the gap loan
        // has to clear both ceilings — collateral, and ten times the injection.
        const byCollateral = needed - mulRate(lendable, 1 - originationPct);
        const byInjection = mulRate(
          needed,
          1 / (1 + (1 - originationPct) / MIN_OWNER_INJECTION_PCT),
        );
        const larger = byCollateral > byInjection ? byCollateral : byInjection;
        const floor = larger > 0n ? larger : 0n;

        console.log(
          note(
            `One number — how much of your own money goes in. The loan, its rate and the` +
              ` revolver follow from it, and more equity prices the loan lower. Anything above` +
              ` your ${toDisplay(investable, { showCents: false })} counts as outside money — a` +
              ` grant, a tax credit, a partner.`,
          ),
        );
        let dealEquity = await ask(
          input,
          `  Equity to invest (min ${toDisplay(floor, { showCents: false })})` +
            ` [${toDisplay(proposedEquity, { showCents: false })}]: `,
          proposedEquity,
          parseMoney,
        );
        for (;;) {
          if (dealEquity < floor) {
            console.log(
              `  ${RED}Below ${toDisplay(floor, { showCents: false })} no lender covers the` +
                ` rest — the loan would breach the collateral or the 10%-injection ceiling.${RESET}`,
            );
            dealEquity = await ask(
              input,
              `  Equity to invest [${toDisplay(floor, { showCents: false })}]: `,
              floor,
              parseMoney,
            );
            continue;
          }
          const shortOfNeed = needed > dealEquity ? needed - dealEquity : 0n;
          loan = shortOfNeed > 0n ? mulRate(shortOfNeed, grossFee) : 0n;
          if (loan === 0n) {
            console.log(`  ${DIM}Fully funded — no debt needed at that figure.${RESET}`);
            break;
          }
          const rate = openingLoanRate(config.primeRate, loan, dealEquity);
          const share = Number(loan) / Number(loan + dealEquity);
          const tierIndex = LEVERAGE_PRICING.findIndex((t) => share <= t.maxDebtShare);
          const cheaper = tierIndex > 0 ? LEVERAGE_PRICING[tierIndex - 1] : undefined;
          const hint = cheaper
            ? ` Putting in ${toDisplay(equityForShare(needed, cheaper.maxDebtShare, originationPct), { showCents: false })}` +
              ` keeps debt at or under ${pctText(cheaper.maxDebtShare)} of the deal and prices` +
              ` at ${pctText(config.primeRate + DEBT_PRODUCTS.SBA_7A.spreadOverPrime + cheaper.spread)}.`
            : '';
          console.log(
            note(
              `That takes a ${toDisplay(loan, { showCents: false })} loan at ${pctText(rate)} —` +
                ` debt is ${pctText(share)} of the deal.${hint}`,
            ),
          );
          const answer = await input.next('  ok, or a higher equity figure > ');
          const said = (answer ?? '').trim();
          if (said === '' || /^(ok|okay|y|yes)$/i.test(said)) break;
          const revised = parseMoney(said);
          if (revised === undefined) {
            console.log(`  ${DIM}A dollar figure, or enter to accept the quote.${RESET}`);
            continue;
          }
          dealEquity = revised;
        }
        // The revolver is proposed, never asked for — nobody arrives knowing a
        // limit. Same $100k target as option 1, inside what is left of the
        // lending ceiling once the term loan has taken its share.
        const onDealEquity = mulRate(dealEquity, 1 / MIN_OWNER_INJECTION_PCT);
        const ceilingNow = lendable < onDealEquity ? lendable : onDealEquity;
        const headroomNow = ceilingNow > loan ? ceilingNow - loan : 0n;
        revolver = headroomNow < revolverTarget ? headroomNow : revolverTarget;
        outside = dealEquity > investable ? dealEquity - investable : 0n;
        equity = dealEquity - outside;
      }

      const debt = [
        ...(loan > 0n ? [{ kind: 'SBA_7A' as const, principal: loan, termQuarters: 40 }] : []),
        ...(revolver > 0n
          ? [{ kind: 'REVOLVER' as const, principal: revolver, termQuarters: 40 }]
          : []),
      ];

      const candidate = buildModelFromTemplate({
        businessName,
        template,
        archetype,
        scale,
        marketingSpendPerQuarter: marketing,
        equityInjection: equity,
        outsideCapital: outside,
        debt,
        ...(concept ? { provenanceFor: concept.mapped.provenanceFor } : {}),
      });

      // The completeness invariant is a hard gate: a model with a hole in its
      // register cannot be committed (§10.2). No amount of money fixes a missing
      // assumption, so this one really does end the run.
      const validation = validateBusinessModel(candidate);
      const errors = validation.issues.filter((i) => i.severity === 'ERROR');
      if (errors.length > 0) {
        console.log(`\n${RED}This model cannot be committed:${RESET}`);
        for (const e of errors) console.log(`  ${RED}${e.code}  ${e.message}${RESET}`);
        return undefined;
      }
      for (const w of validation.issues.filter((i) => i.severity === 'WARNING')) {
        console.log(`\n${YELLOW}⚠ ${w.message}${RESET}`);
      }

      const candidateWorld = createWorld({
        id: 'player-run',
        playerId: 'player',
        config,
      /**
       * No living expenses. §2.3 draws them from household cash every quarter,
       * and they are a second game — personal solvency — running underneath the
       * one being played. Turning off the reserve without turning off the draw
       * would be the worst of both: nothing held back, against a household that
       * still bleeds.
       */
      annualLivingExpenses: 0n,
        models: [candidate],
      });

      console.log(`\n${rule('Before you commit')}`);
      renderOpening(candidate, candidateWorld);

      /**
       * The lender gets a say, which until now it did not.
       *
       * `underwrite` has always been here — collateral coverage, a 10% owner
       * equity minimum, DSCR once there is history — and setup granted every
       * facility unconditionally, so it was never consulted for the one loan
       * that matters most. A live run answered a $203,902 shortfall by asking
       * for a $4M SBA and a $4M revolver against $140,000 of equity and $3.6M
       * of buildout, and got all of it. The engine would have declined it twice
       * over: 10% of $4M is $400,000, and lending value on that capex is $2.16M.
       *
       * It refuses rather than warns, which is only safe because the financing
       * loop exists: a decline sends the player back to the same screen with
       * the reason, instead of ending the run.
       */
      const declined = candidate.financingPlan.debtRequests
        .map((spec) => ({
          spec,
          decision: underwrite(
            candidateWorld.businesses[0]!,
            spec,
            config,
            candidateWorld.household,
            0,
          ),
        }))
        .filter((d) => !d.decision.approved);

      if (declined.length > 0 && attempt < MAX_FINANCING_ATTEMPTS) {
        console.log(`\n${RED}${BOLD}The lender declined.${RESET}`);
        for (const d of declined) {
          console.log(`  ${RED}${d.spec.kind}  ${d.decision.reason}${RESET}`);
        }
        console.log(
          note(
            'Collateral and your own money into the deal are what a first loan is written' +
              ' against — there is no trading history to underwrite yet. More equity, a' +
              ' smaller facility, or a smaller build.',
          ),
        );
        const retry = await input.next('\nTry different financing? (Y/n) ');
        if (retry === undefined) return undefined;
        const t = retry.trim().toLowerCase();
        if (t === 'n' || t === 'no') {
          console.log(`${DIM}Nothing committed.${RESET}`);
          return undefined;
        }
        console.log(`${DIM}  — attempt ${attempt + 1}${RESET}`);
        continue;
      }

      // Phase 4 is a gate, not a formality. A business that cannot fund its own
      // month zero has not been financed; letting it open would start the run with
      // negative cash, which the engine would immediately have to resolve as a
      // crisis on turn one — teaching the player nothing except that the setup
      // screen does not mean what it says.
      if (candidateWorld.businesses[0]!.cash >= 0n) {
        model = candidate;
        world = candidateWorld;
        break;
      }

      // A revolver is a LIMIT, not a drawdown — `openBusiness` sets its
      // outstanding principal to zero. Counting it as money raised produced a
      // message that contradicted itself: "you raised $317k" directly above
      // "you cannot afford $217k". Only term debt actually funds month zero.
      const raised = candidate.financingPlan.equityInjection + loan;
      const shortfall = -candidateWorld.businesses[0]!.cash;

      console.log(
        `\n${RED}${BOLD}Not funded yet.${RESET} ${RED}Month zero costs ` +
          `${toDisplay(computeMonthZeroOutlays(candidate).total)} and you have funded ` +
          `${toDisplay(raised)} — short by ${toDisplay(shortfall)}.${RESET}`,
      );
      if (revolver > 0n) {
        console.log(
          `${DIM}The ${toDisplay(revolver, { showCents: false })} revolver is a limit, not cash:` +
            ` it costs its origination fee at close and draws only when you are short later.${RESET}`,
        );
      }

      if (attempt >= MAX_FINANCING_ATTEMPTS) {
        console.log(
          `${DIM}The gap has not closed in ${MAX_FINANCING_ATTEMPTS} tries, so the business` +
            ` is probably too big for the money rather than badly financed. Run` +
            ` \`pnpm sim --new\` and describe something smaller.${RESET}`,
        );
        return undefined;
      }

      // Only suggest a bigger loan when a bigger loan is available. The lending
      // ceiling is what it is, and "an SBA loan of at least $228,839 would close
      // it" is not advice when the underwriter stops at $312,000 and the plan is
      // already there — it is the same refuse-what-you-recommended fault one
      // screen further on.
      const stillLendable = ceiling > loan ? ceiling - loan : 0n;
      console.log(
        stillLendable >= shortfall
          ? `${DIM}The concept is intact — only the financing needs to change. An SBA loan of` +
              ` at least ${toDisplay(shortfall, { showCents: false })} would close it.${RESET}`
          : `${DIM}The concept is intact, but the money is not there: a lender will write at` +
              ` most ${toDisplay(ceiling, { showCents: false })} against this build and you have` +
              ` ${toDisplay(investable, { showCents: false })} of your own. Either the gap comes` +
              ` from outside the deal — a tax credit, a grant, a partner — or the build gets` +
              ` smaller.${RESET}`,
      );
      const raw = await input.next('\nTry different financing? (Y/n) ');
      // End of input is not consent to keep looping. A scripted run that stops
      // here has said everything it is going to say.
      if (raw === undefined) return undefined;
      const again = raw.trim().toLowerCase();
      if (again === 'n' || again === 'no') {
        console.log(`${DIM}Nothing committed.${RESET}`);
        return undefined;
      }
      console.log(`${DIM}  — attempt ${attempt + 1}${RESET}`);
    }

    renderRegister(model);

    /**
     * The one sentence the campground owner needed, at the moment he needed it.
     *
     * His draft's open notes said it exactly — "not an operating business that
     * services $960k on its own" — and then scrolled away behind month zero, the
     * funding screen and the register. He committed, bled for three years, and
     * concluded he was bad at business. He was not; this screen was.
     */
    if (concept) {
      const heavy = capitalIntensityNote(concept.draft, computeMonthZeroOutlays(model).total);
      if (heavy) console.log(`\n${YELLOW}⚠ ${RESET}${note(heavy).trimStart()}`);
    }

    const objection = await challengeLoop(input, model, options?.transport);
    if (objection === undefined) break;
    journal.write({ kind: 'objection', text: objection });
    if (!concept?.reopen) {
      // The template path has no conversation to reopen. Say what the limit
      // is rather than pretending the words were not understood.
      console.log(
        note(
          'That is a change to the business itself, and without the conversational path' +
            ' this setup can only move numbers. Restart with a model key set to redescribe it.',
        ),
      );
      break;
    }
    console.log(
      note('Taking that back to the interview — a fresh draft, then pricing runs again.'),
    );
    const again = await concept.reopen(objection);
    if (!again) return undefined;
    concept = again;
    template = concept.mapped.template;
    archetype = concept.mapped.archetype;
    scale = concept.mapped.scale;
    businessName = concept.mapped.businessName;
  }

  console.log(
    `\n${DIM}Committing freezes the model. After this it changes only through the` +
      ` actions you take (§9.1 Phase 4).${RESET}`,
  );
  const answer = await ask(input, '\nCommit and open? (y/n) ', 'y', (raw) => {
    const t = raw.trim().toLowerCase();
    return t === 'y' || t === 'yes' ? 'y' : t === 'n' || t === 'no' ? 'n' : undefined;
  });

  journal.write({
    kind: 'commit',
    committed: answer !== 'n',
    equity: toDisplay(model.financingPlan.equityInjection),
    termDebt: toDisplay(
      model.financingPlan.debtRequests
        .filter((d) => d.kind !== 'REVOLVER')
        .reduce<Money>((a, d) => a + d.requestedPrincipal, 0n),
    ),
    openingCash: toDisplay(world.businesses[0]?.cash ?? 0n),
    monthZero: toDisplay(computeMonthZeroOutlays(model).total),
  });

  if (answer === 'n') {
    console.log(`${DIM}Nothing committed.${RESET}`);
    return { world, committed: false, journal };
  }
  return { world, committed: true, journal };
}

export const summariseRegister = (model: BusinessModel): string => {
  const byId: Record<string, Assumption> = {};
  for (const a of model.assumptions) byId[a.id] = a;
  const confidence = computeConfidenceScore({ byId, byPath: {}, confidenceScore: 0 });
  return `${model.assumptions.length} assumptions · confidence ${pctText(confidence)} · ` +
    `${model.assumptions.filter((a) => a.outsideBenchmark).length} out of band`;
};
