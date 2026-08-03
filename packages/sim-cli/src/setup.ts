import { fromDisplay, toDisplay, type Money } from '@bizsim/money';
import {
  buildModelFromTemplate,
  computeMonthZeroOutlays,
  createWorld,
  createWorldConfig,
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
import type { ConceptTransport } from '@bizsim/llm';
import { ask, parseMoney, parseNumber, type LineSource } from './input.js';
import { conceptPathAvailable, runConceptInterview, type ConceptResult } from './concept.js';

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

export interface RunSetupOptions {
  /** Injected in tests so the whole flow runs without a key or a network. */
  transport?: ConceptTransport;
}

export async function runSetup(
  input: LineSource,
  options?: RunSetupOptions,
): Promise<SetupResult | undefined> {
  console.log(`${BOLD}Business Simulator${RESET} ${DIM}— setup${RESET}`);

  const capital = await chooseCapital(input);

  // Phases 1-2. The conversation is the intended path; the picker is what you
  // get when there is no model to talk to, not a co-equal alternative.
  let template: SeedTemplate;
  let archetype: Archetype;
  let scale: ScaleInput;
  let businessName: string;
  let concept: ConceptResult | undefined;

  if (options?.transport || conceptPathAvailable()) {
    concept = await runConceptInterview(input, options?.transport);
    if (!concept) return undefined;
    template = concept.mapped.template;
    archetype = concept.mapped.archetype;
    scale = concept.mapped.scale;
    businessName = concept.mapped.businessName;
  } else {
    console.log(
      `\n${DIM}  No ANTHROPIC_API_KEY, so the conversational path is unavailable and this${RESET}\n` +
        `${DIM}  falls back to picking a template. Set the key to describe a business in${RESET}\n` +
        `${DIM}  your own words instead.${RESET}`,
    );
    template = await chooseTemplate(input);
    archetype = template.defaultArchetypes[0]!;
    scale = await askScale(input, template, archetype);
    businessName = template.label;
  }

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

  for (let attempt = 1; ; attempt++) {
    // Debt is arranged BEFORE equity, because the equity suggestion has to know
    // about it. Sized off a debt-free probe, the suggestion missed the
    // origination fees that only exist once a loan does — so accepting every
    // default landed the player exactly one origination fee short of opening,
    // and the gate refused a business the setup had just recommended.
    const loan = await ask(input, `  ${pad('SBA 7(a) loan', 42)}[$0]: `, 0n, parseMoney);
    const revolver = await ask(
      input,
      `  ${pad('Revolver limit', 42)}[$100,000]: `,
      fromDisplay(100_000),
      parseMoney,
    );
    const debt = [
      ...(loan > 0n ? [{ kind: 'SBA_7A' as const, principal: loan, termQuarters: 40 }] : []),
      ...(revolver > 0n
        ? [{ kind: 'REVOLVER' as const, principal: revolver, termQuarters: 40 }]
        : []),
    ];

    const probe = buildModelFromTemplate({
      businessName,
      template,
      archetype,
      scale,
      marketingSpendPerQuarter: marketing,
      equityInjection: 0n,
      debt,
      ...(concept ? { provenanceFor: concept.mapped.provenanceFor } : {}),
    });
    // A revolver is a limit, not cash at close; only term debt funds month zero.
    const monthZero = computeMonthZeroOutlays(probe).total;
    // Month zero alone is a knife edge: the first quarter's fixed costs land
    // before any revenue does, so a business funded to exactly its opening
    // outlay begins on the crisis ladder. Suggest one quarter of fixed operating
    // cost on top — the buffer a lender would expect to see anyway.
    const quarterOfFixed = probe.costs.fixedPeriod.reduce<Money>(
      (a, c) => a + c.amountPerQuarter,
      0n,
    );
    const needed = monthZero + quarterOfFixed;
    const fundedByDebt = loan;
    const equityNeeded = needed > fundedByDebt ? needed - fundedByDebt : 0n;
    // Never suggest emptying the household. §2.3 draws living expenses from
    // household cash every quarter and a founder who put every dollar into the
    // buildout is personally insolvent by the second one.
    const livingReserve = fromDisplay(60_000);
    const investable =
      config.startCapital > livingReserve ? config.startCapital - livingReserve : 0n;
    const suggestedEquity = equityNeeded < investable ? equityNeeded : investable;
    // The suggestion capping out at the household's investable cash is itself
    // the answer to "how much more do I need" — say so rather than letting the
    // player discover it by being refused.
    if (equityNeeded > investable) {
      console.log(
        `${DIM}  Opening needs about ${toDisplay(needed, { showCents: false })}. Your own` +
          ` cash covers ${toDisplay(investable, { showCents: false })} of it after leaving` +
          ` ${toDisplay(livingReserve, { showCents: false })} to live on — the rest has to be` +
          ` borrowed, or the business has to get smaller.${RESET}`,
      );
    }

    const equity = await ask(
      input,
      `  ${pad('Your own capital into the business', 42)}[${toDisplay(suggestedEquity, { showCents: false })}]: `,
      suggestedEquity,
      parseMoney,
    );

    // Putting the whole household in is allowed and sometimes correct, but it
    // has to be a decision rather than a side effect of typing a round number.
    // §2.3 draws living expenses from household cash every quarter, so a
    // founder who kept nothing is personally insolvent long before the business
    // has had time to work — and the setup screen said nothing about it.
    const householdLeft = config.startCapital > equity ? config.startCapital - equity : 0n;
    if (householdLeft < livingReserve) {
      console.log(
        `\n${YELLOW}⚠ That leaves your household ${toDisplay(householdLeft)}.${RESET}` +
          `${DIM} Living expenses come out of it every quarter whether or not the` +
          ` business pays you. Going in this deep is a real strategy; going in this` +
          ` deep by accident is how a solvent business ends up with a bankrupt owner.${RESET}`,
      );
    }

    const candidate = buildModelFromTemplate({
      businessName,
      template,
      archetype,
      scale,
      marketingSpendPerQuarter: marketing,
      equityInjection: equity,
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
      models: [candidate],
    });

    console.log(`\n${BOLD}═══ BEFORE YOU COMMIT ═══${RESET}`);
    renderOpening(candidate, candidateWorld);

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

    console.log(
      `${DIM}The concept is intact — only the financing needs to change. An SBA loan of` +
        ` at least ${toDisplay(shortfall, { showCents: false })} would close it.${RESET}`,
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
    console.log(`\n${BOLD}MARKETING & FINANCING${RESET} ${DIM}— attempt ${attempt + 1}${RESET}`);
  }

  renderRegister(model);

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
