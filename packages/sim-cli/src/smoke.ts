import { createWorldConfig } from '@bizsim/engine';
import {
  ConceptInterview,
  MalformedDraftError,
  createConceptTransport,
  draftIssues,
  draftToTemplate,
  providerKeyPresent,
  providerKeyVar,
  providerName,
  type CallRecord,
  type ConceptDraft,
} from '@bizsim/llm';
import { fromDisplay } from '@bizsim/money';
import { listSeedTemplates } from '@bizsim/seeds';
import { buildCandidate, proposeFunding, type FundingContext } from './funding.js';
import { buildabilityIssues } from './plausibility.js';
import { spendLine } from './spend.js';

/**
 * The live-call smoke test: one real session against the configured provider.
 *
 * Every other test in this repo runs against scripted transports — nothing
 * asserts that a real provider accepts the requests a transport builds, and
 * that gap is where the live failures have all lived: the draft grammar that
 * exceeded the API's size limit, the seasonality that averaged 0.975. This
 * drives the same path a player does — interview turn, forced draft (staged
 * where the transport supports it), one production-style repair round, map,
 * fund, engine validation — and fails loudly at the first break.
 *
 * Deliberately NOT part of `pnpm check`: it needs a key, costs real money
 * (cents), and its subject is a nondeterministic service. Run it on demand:
 *
 *   pnpm smoke                      # cheapest provider with an exported key
 *   BIZSIM_LLM_PROVIDER=anthropic pnpm smoke
 *
 * Exit code 0 only when every check passes.
 */

const CONCEPT =
  'A mobile espresso cart at a commuter rail station. $4.50 average ticket, ' +
  'I already own the cart, and I will run it myself on weekday mornings.';
const BUILD_IT = 'No more questions — build the model with what you have and estimate the rest.';
const CAPITAL = fromDisplay(500_000);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

let failed = false;
function check(name: string, ok: boolean, detail: string, problems: readonly string[] = []): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  for (const p of problems) console.log(`      - ${p}`);
  if (!ok) failed = true;
}

async function main(): Promise<void> {
  const provider = providerName();
  console.log(`\nlive smoke — provider ${provider}`);

  if (!providerKeyPresent(provider)) {
    check('provider key', false, `no key: export ${providerKeyVar(provider)} (or set BIZSIM_LLM_PROVIDER)`);
    return;
  }
  check('provider key', true, providerKeyVar(provider));

  const calls: CallRecord[] = [];
  const transport = createConceptTransport({ onCall: (r) => calls.push(r) });

  let staged = 0;
  const interview = new ConceptInterview({
    transport,
    templates: listSeedTemplates().map((t) => ({ id: t.id, label: t.label })),
    investable: '$500,000',
    onStage: ({ index, total, label }) => {
      staged += 1;
      console.log(`      stage ${index + 1}/${total}: ${label}`);
    },
  });

  // 1. One interview turn: the turn grammar compiles on the wire, the reply
  //    parses, and the model behaves like an interviewer.
  const turnStart = Date.now();
  const state = await interview.send(CONCEPT);
  check(
    'turn call',
    state.status !== 'EXHAUSTED' && state.message.trim().length > 0,
    `${state.status.toLowerCase()} in ${seconds(Date.now() - turnStart)}`,
  );

  // 2. The forced draft — the web "Build It" path. Staged transports exercise
  //    the four per-stage grammars; the rest exercise the one-shot grammar.
  //    One production-style repair round (concept.ts sends the same message)
  //    before structural issues count as a failure.
  let draft: ConceptDraft;
  const draftStart = Date.now();
  try {
    draft =
      state.status === 'DRAFTED' ? state.draft : await interview.finish(BUILD_IT);
    let issues = [...draftIssues(draft), ...buildabilityIssues(draft)];
    if (issues.length > 0) {
      console.log(`      repair round: ${issues.length} structural issue(s)`);
      draft = await interview.finish(
        `That draft has structural problems: ${issues.join(' ')} ` +
          `Please correct them and emit the draft again.`,
      );
      issues = [...draftIssues(draft), ...buildabilityIssues(draft)];
    }
    check(
      'draft synthesis',
      true,
      `${staged > 0 ? `staged, ${staged} stages` : 'one-shot'} in ${seconds(Date.now() - draftStart)}`,
    );
    check('draft structure', issues.length === 0, `${issues.length} issue(s) after repair`, issues);
    if (issues.length > 0) return;
  } catch (error) {
    const kind = error instanceof MalformedDraftError ? 'malformed after retries' : 'call failed';
    check('draft synthesis', false, `${kind}: ${(error as Error).message}`);
    return;
  }

  // 3. The deterministic tail a real player hits next: map, propose funding,
  //    build the candidate world, engine validation. No model calls from here.
  const mapped = draftToTemplate(draft);
  const ctx: FundingContext = {
    businessName: mapped.businessName,
    template: mapped.template,
    archetype: mapped.archetype,
    scale: mapped.scale,
    marketing: mapped.template.modifierDefaults.baseMarketingSpendPerQuarter,
    config: createWorldConfig({ startMode: 'FREEPLAY', customCapital: CAPITAL }),
    provenanceFor: mapped.provenanceFor,
  };
  const proposal = proposeFunding(ctx);
  const candidate = buildCandidate(ctx, {
    equity: proposal.proposedEquity,
    outside: 0n,
    loan: proposal.proposedLoan,
    revolver: proposal.proposedRevolver,
  });
  check('mapped and funded', true, `"${mapped.businessName}" (${mapped.archetype})`);
  check(
    'engine validation',
    candidate.errors.length === 0,
    `${candidate.errors.length} error(s), ${candidate.warnings.length} warning(s)`,
    candidate.errors,
  );

  const spent = spendLine(calls);
  if (spent) console.log(`\n${spent}`);
}

main()
  .catch((error: unknown) => {
    failed = true;
    console.error(`\n  ✗ smoke crashed: ${(error as Error).message}`);
  })
  .finally(() => {
    console.log(failed ? '\nFAIL — the wire is broken somewhere above.' : '\nPASS — the wire works end to end.');
    process.exitCode = failed ? 1 : 0;
  });
