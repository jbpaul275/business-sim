import { execFileSync } from 'node:child_process';
import { fromDisplay, mulRate, toDisplay, type Money } from '@bizsim/money';
import {
  DEBT_PRODUCTS,
  MIN_OWNER_INJECTION_PCT,
  buildModelFromTemplate,
  collateralValue,
  underwrite,
  computeMonthZeroOutlays,
  createWorld,
  setAtPath,
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
import { findCatalogItem, listSeedTemplates } from '@bizsim/seeds';
import {
  adjudicate,
  reverseChallenge,
  type AdjudicationTransport,
  type ConceptTransport,
} from '@bizsim/llm';
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
        { key: 'skuCount', label: 'Menu items', fallback: num('skuCount', 40), band: 'more slows service' },
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
      const value = a.isMoney ? toDisplay(a.value as bigint, { showCents: false }) : String(a.value);
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
      const value = a.isMoney ? toDisplay(a.value as bigint, { showCents: false }) : String(a.value);
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
): Promise<void> {
  // Worth arguing with first: furthest out of band, then the unsourced.
  const arguable = [...model.assumptions]
    .filter((a) => a.outsideBenchmark || !isWellSourced(a.provenance))
    .sort(
      (a, b) =>
        Math.abs(b.benchmarkDeviation ?? 0) - Math.abs(a.benchmarkDeviation ?? 0) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, 12);
  if (arguable.length === 0) return;

  console.log(
    `\n  ${DIM}\`challenge <n> <value> [why]\` argues with one of these. A bare number moves it` +
      ` at most to the\n  edge of its range; a real basis — a quote, a listing, a model number —` +
      ` moves it properly.${RESET}`,
  );
  arguable.forEach((a, i) => {
    const value = a.isMoney ? toDisplay(a.value as bigint, { showCents: false }) : String(a.value);
    console.log(`    ${rpad(String(i + 1), 3)}  ${pad(a.label, 38)}${rpad(value, 12)}  ${DIM}${a.provenance}${RESET}`);
  });

  while (true) {
    const raw = await input.next('\n  challenge, or enter to move on > ');
    if (raw === undefined || raw.trim() === '') return;
    const [verb = '', indexToken = '', valueToken = '', ...basisWords] = raw.trim().split(/\s+/);
    if (verb.toLowerCase() !== 'challenge') {
      console.log(`  ${DIM}\`challenge 3 22000 used unit on MachineryTrader\`, or enter to move on.${RESET}`);
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
    const asNumber = (v: number | bigint): number => (typeof v === 'bigint' ? Number(v) / 100 : v);
    const catalog = findCatalogItem(target.label);
    const settled = await adjudicate(transport ? adjudicationOf(transport) : undefined, {
      assumption: {
        label: target.label,
        value: asNumber(target.value),
        unit: target.unit,
        range: { low: asNumber(target.range.low), high: asNumber(target.range.high) },
        sourceNote: target.sourceNote,
        provenance: target.provenance,
        benchmarkBand: target.benchmarkBand
          ? { low: target.benchmarkBand.low, high: target.benchmarkBand.high }
          : null,
      },
      playerClaim: {
        assertedValue: asNumber(asserted as number | bigint),
        statedBasis: basis === '' ? null : basis,
        evidenceUrl: null,
      },
      businessContext: {
        archetype: model.streams[0]?.archetype ?? 'TRAFFIC',
        summary: model.businessName,
      },
      catalogEntry: catalog
        ? {
            label: catalog.label,
            low: catalog.low,
            high: catalog.high,
            tiers: catalog.tiers,
            source: catalog.source,
          }
        : null,
    });

    console.log(`  ${RULING_COLOUR[settled.ruling]}${settled.ruling}${RESET}  ${wrapText(settled.reasoning, 70, '        ')}`);
    if (settled.clarifyingQuestion) {
      console.log(`  ${CYAN}? ${wrapText(settled.clarifyingQuestion, 70, '    ')}${RESET}`);
    }
    if (settled.secondOrderEffect) {
      console.log(`  ${DIM}↳ ${wrapText(settled.secondOrderEffect, 70, '    ')}${RESET}`);
    }

    if (settled.provenance === 'UNCHANGED') continue;

    const landed = target.isMoney ? fromDisplay(settled.value) : settled.value;
    // The register is a record OF the model, so both move or neither does.
    if (!setAtPath(model, target.path, landed)) {
      console.log(`  ${RED}${target.label} is registered at ${target.path}, which no longer resolves.${RESET}`);
      continue;
    }
    target.challengeHistory.push({
      period: 0,
      priorValue: target.value,
      assertedValue: asserted as number | bigint,
      statedBasis: basis === '' ? null : basis,
      ruling: settled.ruling,
      resultingValue: landed,
      reasoning: settled.reasoning,
    });
    target.value = landed;
    target.provenance = settled.provenance;
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

function renderOpening(model: BusinessModel, world: WorldState): void {
  const outlays = computeMonthZeroOutlays(model);
  const business = world.businesses[0]!;

  console.log(`\n${BOLD}MONTH ZERO${RESET}  ${DIM}— cash out before you serve a single customer (§5.4)${RESET}`);
  const rows: [string, Money][] = [
    ['Lease signing (first + last + deposit)', outlays.leaseSigning],
    ['Buildout & equipment', outlays.buildoutAndEquipment],
    ['Opening inventory', outlays.initialInventory],
    ['Permits & legal', outlays.permitsAndLegal],
    ['Prepaid insurance', outlays.prepaidInsurance],
    ['Pre-opening payroll & training', outlays.preOpeningPayroll],
    ['Pre-opening marketing', outlays.preOpeningMarketing],
    ['Debt origination fees', outlays.debtOriginationFees],
  ];
  for (const [label, value] of rows) {
    if (value === 0n) continue;
    console.log(`  ${pad(label, 42)}${rpad(toDisplay(value), 16)}`);
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
    concept = await runConceptInterview(input, options?.transport, journal);
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
  const marketing = template.modifierDefaults.baseMarketingSpendPerQuarter;

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

    const proposedEquity = needed < investable ? needed : investable;
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
      loan = await ask(
        input,
        `  ${pad('SBA 7(a) loan', 42)}[${toDisplay(proposedLoan, { showCents: false })}]: `,
        proposedLoan,
        parseMoney,
      );
      revolver = await ask(
        input,
        `  ${pad('Revolver limit', 42)}[${toDisplay(proposedRevolver, { showCents: false })}]: `,
        proposedRevolver,
        parseMoney,
      );
      equity = await ask(
        input,
        `  ${pad('Your own capital into the business', 42)}[${toDisplay(proposedEquity, { showCents: false })}]: `,
        proposedEquity,
        parseMoney,
      );
      /**
       * The line the solar farm had nowhere to put.
       *
       * Its drafted stack was $1.0M sponsor equity, ~$1.5M of transferred
       * federal ITC and ~$3.2M of debt. The screen carried the first and the
       * third, dropped the credit, and refused the project as unaffordable —
       * having itself established that the credit was most of what made it
       * financeable.
       */
      outside = await ask(
        input,
        `  ${pad('Grants, tax credits, outside equity', 42)}[$0]: `,
        0n,
        parseMoney,
      );
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

  await challengeLoop(input, model, options?.transport);

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
