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
export { postmortem, runPoint, type RunPoint } from './postmortem.js';
export { priceUnits } from './pricing.js';
