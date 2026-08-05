import type {
  BusinessModel,
  ValidationIssue,
  ValidationResult,
} from '@bizsim/schemas';
import { ARCHETYPE_DRIVER, MIN_SQ_FT_PER_SEAT, maxSeatsFor } from '@bizsim/schemas';

/**
 * `validateBusinessModel` — spec §10.2 and §11.2.
 *
 * The completeness invariant is the load-bearing rule here:
 *
 * > Every numeric parameter that feeds the engine must have a corresponding
 * > Assumption record.
 *
 * Without it the register decays into a partial log and the export loses its
 * credibility claim. A model that fails this cannot be committed.
 */

/** Parameters that feed the engine and therefore need a registered assumption. */
function requiredPaths(model: BusinessModel): string[] {
  const paths: string[] = [];

  for (const stream of model.streams) {
    const base = `streams.${stream.id}`;
    for (const key of Object.keys(stream.params)) {
      if (key === 'kind' || key === 'capacityModel') continue;
      paths.push(`${base}.params.${key}`);
    }
    if (stream.params.kind === 'TRAFFIC') {
      const model_ = stream.params.capacityModel;
      for (const key of Object.keys(model_)) {
        if (key === 'kind') continue;
        paths.push(`${base}.params.capacityModel.${key}`);
      }
    }
    for (const key of Object.keys(stream.modifiers)) {
      paths.push(`${base}.modifiers.${key}`);
    }
    paths.push(`${base}.marketingSpendPerQuarter`);
    paths.push(`${base}.seasonality`);
  }

  for (const cost of model.costs.variableWithRevenue) paths.push(`costs.${cost.id}.pctOfRevenue`);
  for (const cost of model.costs.variableWithActivity) paths.push(`costs.${cost.id}.costPerUnit`);
  for (const cost of model.costs.stepFixed) {
    paths.push(`costs.${cost.id}.blockCostPerQuarter`);
    paths.push(`costs.${cost.id}.capacityPerBlock`);
  }
  for (const cost of model.costs.fixedPeriod) {
    paths.push(`costs.${cost.id}.amountPerQuarter`);
    paths.push(`costs.${cost.id}.annualEscalatorPct`);
  }
  paths.push('costs.payrollLoadPct');

  for (const key of Object.keys(model.workingCapital)) paths.push(`workingCapital.${key}`);
  for (const capex of model.capex) paths.push(`capex.${capex.label}.grossCost`);

  return paths;
}

export function validateBusinessModel(model: BusinessModel): ValidationResult {
  const issues: ValidationIssue[] = [];

  const registered = new Set(model.assumptions.map((a) => a.path));
  for (const path of requiredPaths(model)) {
    if (!registered.has(path)) {
      issues.push({
        severity: 'ERROR',
        code: 'MISSING_ASSUMPTION',
        path,
        message: `No assumption registered for ${path}. Every numeric parameter that feeds the engine needs one (§10.2).`,
      });
    }
  }

  for (const stream of model.streams) {
    const average = stream.seasonality.reduce((a, b) => a + b, 0) / 4;
    if (Math.abs(average - 1) > 0.01) {
      issues.push({
        severity: 'ERROR',
        code: 'SEASONALITY_NOT_NORMALISED',
        path: `streams.${stream.id}.seasonality`,
        message: `Seasonality must average 1.00 ± 0.01; this averages ${average.toFixed(3)}.`,
      });
    }

    // A UTILIZATION stream with no staffed capacity has no binding constraint —
    // its whole model is hours of skilled people you can sell (§3.2).
    if (stream.params.kind === 'UTILIZATION') {
      const hasLabor = model.costs.stepFixed.some(
        (c) => c.capacity.driver === 'BILLABLE_HOURS',
      );
      if (!hasLabor) {
        issues.push({
          severity: 'ERROR',
          code: 'UTILIZATION_WITHOUT_STAFFING',
          path: `streams.${stream.id}`,
          message:
            'A UTILIZATION stream needs a STEP_FIXED line driven by BILLABLE_HOURS; ' +
            'billable capacity comes from staffed blocks.',
        });
      }
    }

    if (stream.params.referencePrice <= 0n) {
      issues.push({
        severity: 'ERROR',
        code: 'MISSING_REFERENCE_PRICE',
        path: `streams.${stream.id}.params.referencePrice`,
        message: 'referencePrice is the elasticity anchor and must be set at concept lock.',
      });
    }

    // D-5: the one thing the engine refuses is physical impossibility. Seats
    // are the input every unbounded revenue claim runs through — capacity is
    // seats × turns × days, so nothing else caps a concept that asserts a
    // hundred thousand of them. This is a building code, not an opinion about
    // the business, which is exactly why it is allowed to be a hard error.
    if (stream.params.kind === 'TRAFFIC' && stream.params.capacityModel.kind === 'SEAT_TURNS') {
      const { seats, floorAreaSqFt } = stream.params.capacityModel;
      const capacity = maxSeatsFor(floorAreaSqFt);
      if (seats > capacity) {
        issues.push({
          severity: 'ERROR',
          code: 'CAPACITY_EXCEEDS_FOOTPRINT',
          path: `streams.${stream.id}.params.capacityModel.seats`,
          message:
            `${seats} seats will not fit in ${floorAreaSqFt} sq ft. At ${MIN_SQ_FT_PER_SEAT} sq ft ` +
            `per seat — the code minimum for standing assembly, so already generous — that space ` +
            `holds ${capacity}. Either take ${Math.ceil(seats * MIN_SQ_FT_PER_SEAT)} sq ft ` +
            `(and carry the rent) or seat ${capacity}.`,
        });
      }
    }
  }

  // §4.5: the payroll load is challengeable but it cannot be zero. Founders
  // model $20/hr when the real number is $26/hr.
  if (model.costs.payrollLoadPct <= 0) {
    issues.push({
      severity: 'ERROR',
      code: 'ZERO_PAYROLL_LOAD',
      path: 'costs.payrollLoadPct',
      message: 'Payroll load cannot be zero (§4.5).',
    });
  }

  const ownerComp = model.costs.fixedPeriod.find((c) => c.isOwnerComp);
  if (!ownerComp || ownerComp.amountPerQuarter <= 0n) {
    issues.push({
      severity: 'WARNING',
      code: 'NO_OWNER_COMPENSATION',
      path: 'costs.fixedPeriod',
      message:
        'This model excludes owner compensation. Every projection built this way shows ' +
        'phantom profit and is not comparable to a salary — the export must say so ' +
        'prominently (§4.6, §12.4).',
    });
  }

  if (model.legalForm === 'S_CORP' && (!ownerComp || ownerComp.amountPerQuarter <= 0n)) {
    issues.push({
      severity: 'ERROR',
      code: 'S_CORP_WITHOUT_OWNER_COMP',
      path: 'legalForm',
      message: 'An S-corp requires reasonable owner W-2 compensation (§7.1).',
    });
  }

  for (const cost of model.costs.variableWithActivity) {
    if (cost.driver === 'REVENUE') {
      issues.push({
        severity: 'WARNING',
        code: 'ACTIVITY_COST_ON_REVENUE',
        path: `costs.${cost.id}.driver`,
        message:
          'A cost that scales with revenue dollars belongs in VARIABLE_REVENUE. The point ' +
          'of VARIABLE_ACTIVITY is that it is decoupled from price (§4.2).',
      });
    }
  }

  for (const stream of model.streams) {
    const driver = ARCHETYPE_DRIVER[stream.params.kind];
    const lines = model.costs.stepFixed.filter((c) => c.capacity.driver === driver);
    for (const line of lines) {
      // The owner-worked block satisfies the operating floor: a solo operator
      // with zero paid staff is a legitimate business, not a validation error.
      if (line.minimumBlocks > line.currentBlocks + (line.ownerBlocks ?? 0)) {
        issues.push({
          severity: 'ERROR',
          code: 'BLOCKS_BELOW_MINIMUM',
          path: `costs.${line.id}.currentBlocks`,
          message: `${line.label} starts below its own minimum block count.`,
        });
      }
    }
  }

  return { valid: !issues.some((i) => i.severity === 'ERROR'), issues };
}
