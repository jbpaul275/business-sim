/**
 * @bizsim/engine — the deterministic financial engine.
 *
 * Pure. No randomness, no Date.now(), no network, no filesystem. A tick is a
 * pure function of (WorldState, Action[]) → (WorldState, StatementSet,
 * AssertionResult[]), and that purity is what makes 40-period runs trustworthy
 * and replay possible.
 *
 * The public surface is deliberately small — everything else is internal so the
 * engine stays replaceable and the replay guarantee stays enforceable.
 */

export { tick, type TickOptions, type TickResult } from './tick.js';
export { replay, replayFromGenesis, type ActionLogEntry } from './replay.js';
export { validateBusinessModel } from './validate.js';
export {
  createWorld,
  createWorldConfig,
  computeMonthZeroOutlays,
  clampFreeplay,
  type CreateWorldInput,
  type WorldConfigInput,
} from './opening.js';
export { injectOmissionGuardLines, payrollLoadPct } from './omissionGuard.js';
export { irr } from './metrics.js';
export { setAtPath } from './assumptionPath.js';
export {
  cloneBusiness,
  cloneOutlay,
  saleValue,
  CLONE_RAMP_BONUS,
  CLONE_RAMP_CEILING,
} from './clone.js';
export { priceAt, portfolioValue, quarterlyDividend, totalReturnValue } from './market.js';

// Exposed for the CLI, tests, seed calibration and the export's formula
// emitter, all of which need to reproduce a single figure without running a
// whole tick.
export {
  maturityRamp,
  marketingMultiplier,
  priceEffect,
  serviceComplexityFactor,
  seasonalityFactor,
  quarterOfYear,
} from './modifiers.js';
export {
  annuityPayment,
  collateralValue,
  underwrite,
  DEBT_PRODUCTS,
  MIN_OWNER_INJECTION_PCT,
  LEVERAGE_PRICING,
  leverageSpread,
  openingLoanRate,
} from './debt.js';
export { computeTax, SECTION_179_CAP, SE_TAX_WAGE_BASE } from './tax.js';
export { quarterlyDepreciation } from './depreciation.js';
export {
  maintenanceReservePerQuarter,
  resolveCapacity,
  streamVariableCosts,
  type StreamVariableCosts,
} from './costs.js';
export { deltaNetWorkingCapital, cashConversionCycle } from './workingCapital.js';
export type { ComputationTrace } from './context.js';
export type { CapacityResolution } from './costs.js';
export {
  buildModelFromTemplate,
  type BuildModelOptions,
  type ScaleInput,
} from './buildModel.js';
// The advisor has to be able to say "marketing does nothing for this
// archetype" without guessing, and to read the price off a stream without
// re-implementing the six-way switch that would drift from this one.
export { streamPrice, marketingMovesDemand } from './archetypes.js';
