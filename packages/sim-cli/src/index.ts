/**
 * The pieces of the CLI other frontends reuse — apps/web today.
 *
 * The CLI was the first UI, not the only one (§11.4: "natural language is the
 * on-ramp, not the only road" cuts both ways). What it grew that any frontend
 * needs: the reference scenarios, the event describer, and §10.4's attribution
 * sentence. Deliberately NOT exported: the play loop and anything that touches
 * stdin — importing this module must never start a terminal session.
 */
export { SCENARIOS } from './scenarios.js';
export { describeEvent } from './events.js';
export { buildBriefing, describeAttribution, type BriefingContext } from './briefing.js';
export { selectAxis, type EigenAxis, type EigenInput } from './eigen.js';
export { postmortem, runPoint, type RunPoint } from './postmortem.js';
export { priceUnits } from './pricing.js';
export { journalActions, type Journal, type JournalEvent } from './journal.js';
export { argueAssumption, arguableAssumptions, type ArgueOutcome, type ArgueRequest } from './argue.js';
export {
  proposeFunding,
  quoteForEquity,
  revolverFor,
  buildCandidate,
  candidatePlans,
  equityForShare,
  type FundingContext,
  type FundingProposal,
  type LoanQuote,
  type CandidatePlan,
  type CandidateResult,
  type NamedPlan,
} from './funding.js';
export {
  depthGauge,
  planDepth,
  stressDemand,
  type DepthGauge,
  type PlanDepth,
} from './depth.js';
export {
  buildabilityIssues,
  capacityCeilingIssues,
  capitalIntensityNote,
  duplicateOverheadIssues,
  projectMatureRevenue,
  revenueRealityIssues,
  staffingRealismIssues,
} from './plausibility.js';
export { spendLine } from './spend.js';
export {
  shareNotice,
  shareRun,
  sessionIdForFile,
  readEvents,
  uploadTarget,
  type ShareResult,
} from './upload.js';
