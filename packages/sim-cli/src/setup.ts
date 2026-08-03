import { fromDisplay, toDisplay, type Money } from '@bizsim/money';
import {
  buildModelFromTemplate,
  computeMonthZeroOutlays,
  createWorld,
  createWorldConfig,
  validateBusinessModel,
  type ScaleInput,
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
  type SeedTemplate,
  type WorldState,
} from '@bizsim/schemas';
import { listSeedTemplates } from '@bizsim/seeds';
import { ask, parseMoney, parseNumber, type LineSource } from './input.js';

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

async function chooseCapital(input: LineSource): Promise<{ mode: 'LOW' | 'MID' | 'FREEPLAY'; custom?: Money }> {
  console.log(`\n${BOLD}STARTING CAPITAL${RESET}  ${DIM}— everything you have to put at risk${RESET}`);
  console.log(`  1  Low       ${rpad(toDisplay(START_CAPITAL.LOW, { showCents: false }), 12)}  ${DIM}tight; most concepts will need debt${RESET}`);
  console.log(`  2  Mid       ${rpad(toDisplay(START_CAPITAL.MID, { showCents: false }), 12)}  ${DIM}room for one serious swing${RESET}`);
  console.log(`  3  Custom    ${DIM}free play, capped at $1B${RESET}`);

  const choice = await ask(input, '> ', 2, (raw) => {
    const n = parseNumber(raw);
    return n === 1 || n === 2 || n === 3 ? n : undefined;
  });

  if (choice === 1) return { mode: 'LOW' };
  if (choice === 2) return { mode: 'MID' };
  const custom = await ask(input, '  How much? ', START_CAPITAL.MID, parseMoney);
  return { mode: 'FREEPLAY', custom };
}

// ---------------------------------------------------------------------------
// Phases 1–2 — concept and synthesis, structured
// ---------------------------------------------------------------------------

async function chooseTemplate(input: LineSource): Promise<SeedTemplate> {
  const templates = listSeedTemplates();
  console.log(`\n${BOLD}WHAT ARE YOU BUILDING?${RESET}`);
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
  console.log(`\n${BOLD}SCALE${RESET}  ${DIM}— enter to accept the seeded default${RESET}`);
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
    console.log(`\n  ${YELLOW}${outOfBand.length} outside their benchmark band:${RESET}`);
    for (const a of outOfBand.slice(0, 8)) {
      const value = a.isMoney ? toDisplay(a.value as bigint, { showCents: false }) : String(a.value);
      const band = a.benchmarkBand;
      const magnitude = deviationLabel(a);
      console.log(
        `    ${pad(a.label, 34)}${rpad(value, 12)}  ${YELLOW}${rpad(magnitude ?? '', 26)}${RESET}` +
          `${DIM}band ${band?.low}–${band?.high} · ${band?.source ?? ''}${RESET}`,
      );
    }
    console.log(
      `\n  ${DIM}Out of band is not wrong — it is a number that has to be earned. The sim${RESET}\n` +
        `  ${DIM}will ask what makes it true when the adjudication loop lands (§11.3.1).${RESET}`,
    );
  }

  // PLAYER_ASSUMED ranks BELOW the model's own estimate (§10.3): an unsupported
  // assertion by an optimistic founder is the least reliable input in the system.
  const assumed = weak.filter((a) => a.provenance === 'PLAYER_ASSUMED');
  if (assumed.length > 0) {
    console.log(`\n  ${RED}${assumed.length} are your assertions with no evidence behind them:${RESET}`);
    for (const a of assumed.slice(0, 6)) {
      const value = a.isMoney ? toDisplay(a.value as bigint, { showCents: false }) : String(a.value);
      console.log(`    ${pad(a.label, 34)}${rpad(value, 12)}  ${DIM}${a.sourceNote}${RESET}`);
    }
  }
}

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
  const debt = model.financingPlan.debtRequests.reduce<Money>((a, d) => a + d.requestedPrincipal, 0n);
  console.log(
    `\n  You put in ${BOLD}${toDisplay(equity)}${RESET} and borrow ${BOLD}${toDisplay(debt)}${RESET}.`,
  );
  const cashColour = business.cash <= 0n ? RED : business.cash < fromDisplay(50_000) ? YELLOW : GREEN;
  console.log(`  Opening cash        ${cashColour}${toDisplay(business.cash)}${RESET}`);
  console.log(`  Household keeps     ${toDisplay(world.household.cash)}`);

  if (business.cash <= 0n) {
    console.log(
      `\n  ${RED}You cannot afford to open. Raise more equity or debt, or build something smaller.${RESET}`,
    );
  } else if (business.cash < fromDisplay(50_000)) {
    console.log(
      `\n  ${YELLOW}That is thin. Month zero is not the peak — the peak comes when you are` +
        ` open and still losing money.${RESET}`,
    );
  }
}

// ---------------------------------------------------------------------------

export interface SetupResult {
  world: WorldState;
  committed: boolean;
}

export async function runSetup(input: LineSource): Promise<SetupResult | undefined> {
  console.log(`${BOLD}Business Simulator${RESET} ${DIM}— setup${RESET}`);

  const capital = await chooseCapital(input);
  const template = await chooseTemplate(input);
  const archetype = template.defaultArchetypes[0]!;
  const scale = await askScale(input, template, archetype);

  console.log(`\n${BOLD}MARKETING & FINANCING${RESET}`);
  const marketing = await ask(
    input,
    `  ${pad('Marketing per quarter', 42)}[${toDisplay(template.modifierDefaults.baseMarketingSpendPerQuarter, { showCents: false })}]: `,
    template.modifierDefaults.baseMarketingSpendPerQuarter,
    parseMoney,
  );

  const config = createWorldConfig(
    capital.custom !== undefined
      ? { startMode: capital.mode, customCapital: capital.custom }
      : { startMode: capital.mode },
  );

  // Size a starting suggestion off what it actually costs to open.
  const probe = buildModelFromTemplate({
    businessName: template.label,
    template,
    archetype,
    scale,
    marketingSpendPerQuarter: marketing,
    equityInjection: 0n,
  });
  const needed = computeMonthZeroOutlays(probe).total;
  // Never suggest emptying the household. §2.3 draws living expenses from
  // household cash every quarter and a founder who put every dollar into the
  // buildout is personally insolvent by the second one.
  const livingReserve = fromDisplay(60_000);
  const investable =
    config.startCapital > livingReserve ? config.startCapital - livingReserve : 0n;
  const suggestedEquity = needed < investable ? needed : investable;

  const equity = await ask(
    input,
    `  ${pad('Your own capital into the business', 42)}[${toDisplay(suggestedEquity, { showCents: false })}]: `,
    suggestedEquity,
    parseMoney,
  );
  const loan = await ask(input, `  ${pad('SBA 7(a) loan', 42)}[$0]: `, 0n, parseMoney);
  const revolver = await ask(
    input,
    `  ${pad('Revolver limit', 42)}[$100,000]: `,
    fromDisplay(100_000),
    parseMoney,
  );

  const model = buildModelFromTemplate({
    businessName: template.label,
    template,
    archetype,
    scale,
    marketingSpendPerQuarter: marketing,
    equityInjection: equity,
    debt: [
      ...(loan > 0n ? [{ kind: 'SBA_7A' as const, principal: loan, termQuarters: 40 }] : []),
      ...(revolver > 0n ? [{ kind: 'REVOLVER' as const, principal: revolver, termQuarters: 40 }] : []),
    ],
  });

  // The completeness invariant is a hard gate: a model with a hole in its
  // register cannot be committed (§10.2).
  const validation = validateBusinessModel(model);
  const errors = validation.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length > 0) {
    console.log(`\n${RED}This model cannot be committed:${RESET}`);
    for (const e of errors) console.log(`  ${RED}${e.code}  ${e.message}${RESET}`);
    return undefined;
  }
  for (const w of validation.issues.filter((i) => i.severity === 'WARNING')) {
    console.log(`\n${YELLOW}⚠ ${w.message}${RESET}`);
  }

  const world = createWorld({
    id: 'player-run',
    playerId: 'player',
    config,
    models: [model],
  });

  console.log(`\n${BOLD}═══ BEFORE YOU COMMIT ═══${RESET}`);
  renderOpening(model, world);
  renderRegister(model);

  // Phase 4 is a gate, not a formality. A business that cannot fund its own
  // month zero has not been financed; letting it open would start the run with
  // negative cash, which the engine would immediately have to resolve as a
  // crisis on turn one — teaching the player nothing except that the setup
  // screen does not mean what it says.
  if (world.businesses[0]!.cash < 0n) {
    console.log(
      `\n${RED}${BOLD}Cannot commit.${RESET} ${RED}Month zero costs ` +
        `${toDisplay(computeMonthZeroOutlays(model).total)} and you have raised ` +
        `${toDisplay(model.financingPlan.equityInjection + model.financingPlan.debtRequests.reduce<Money>((a, d) => a + d.requestedPrincipal, 0n))}.${RESET}`,
    );
    console.log(
      `${DIM}Raise more, or build something smaller — fewer seats, a cheaper buildout,` +
        ` a smaller location. Run \`pnpm sim --new\` again.${RESET}`,
    );
    return undefined;
  }

  console.log(
    `\n${DIM}Committing freezes the model. After this it changes only through the` +
      ` actions you take (§9.1 Phase 4).${RESET}`,
  );
  const answer = await ask(input, '\nCommit and open? (y/n) ', 'y', (raw) => {
    const t = raw.trim().toLowerCase();
    return t === 'y' || t === 'yes' ? 'y' : t === 'n' || t === 'no' ? 'n' : undefined;
  });

  if (answer === 'n') {
    console.log(`${DIM}Nothing committed.${RESET}`);
    return { world, committed: false };
  }
  return { world, committed: true };
}

export const summariseRegister = (model: BusinessModel): string => {
  const byId: Record<string, Assumption> = {};
  for (const a of model.assumptions) byId[a.id] = a;
  const confidence = computeConfidenceScore({ byId, byPath: {}, confidenceScore: 0 });
  return `${model.assumptions.length} assumptions · confidence ${pctText(confidence)} · ` +
    `${model.assumptions.filter((a) => a.outsideBenchmark).length} out of band`;
};
