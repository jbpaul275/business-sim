import { describe, expect, it } from 'vitest';
import { fromDisplay } from '@bizsim/money';
import { getSeedTemplate, listSeedTemplates, validateMonthlyWeights } from '@bizsim/seeds';
import type { BusinessModel } from '@bizsim/schemas';
import { buildModelFromTemplate } from './buildModel.js';
import { injectOmissionGuardLines } from './omissionGuard.js';
import { validateBusinessModel } from './validate.js';
import { computeMonthZeroOutlays, clampFreeplay } from './opening.js';

function model(): BusinessModel {
  return buildModelFromTemplate({
    businessName: 'Validation Test',
    template: getSeedTemplate('full_service_restaurant'),
    scale: {
      seats: 64,
      turnsPerDay: 2,
      addressableTrafficPerQuarter: 180_000,
      captureRate: 0.05,
      price: fromDisplay(42),
    },
    equityInjection: fromDisplay(350_000),
  });
}

describe('completeness invariant (§10.2)', () => {
  it('a template-built model registers an assumption for every engine parameter', () => {
    const result = validateBusinessModel(model());
    const missing = result.issues.filter((i) => i.code === 'MISSING_ASSUMPTION');
    expect(missing.map((m) => m.path)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a model whose assumption register has a hole in it', () => {
    const m = model();
    m.assumptions = m.assumptions.filter((a) => !a.path.endsWith('.captureRate'));
    const result = validateBusinessModel(m);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'MISSING_ASSUMPTION')).toBe(true);
  });

  it('every injected omission-guard line carries an assumption too', () => {
    const m = model();
    const guardLines = [
      ...m.costs.fixedPeriod.filter((c) => c.id.startsWith('og_')),
      ...m.costs.variableWithRevenue.filter((c) => c.id.startsWith('og_')),
    ];
    expect(guardLines.length).toBeGreaterThan(5);

    const paths = new Set(m.assumptions.map((a) => a.path));
    for (const line of guardLines) {
      const expected =
        line.class === 'FIXED_PERIOD'
          ? `costs.${line.id}.amountPerQuarter`
          : `costs.${line.id}.pctOfRevenue`;
      expect(paths.has(expected), `${line.label} has no registered assumption`).toBe(true);
    }
  });
});

describe('the omission guard (§4.6)', () => {
  it('injects owner compensation, and it is not optional by default', () => {
    const m = model();
    const ownerComp = m.costs.fixedPeriod.find((c) => c.isOwnerComp);
    expect(ownerComp).toBeDefined();
    expect(ownerComp!.amountPerQuarter).toBeGreaterThan(0n);
    // Market rate for the role, minimum $45k/yr.
    expect(Number(ownerComp!.amountPerQuarter) * 4).toBeGreaterThanOrEqual(45_000 * 100);
  });

  it('warns loudly when owner compensation is zeroed', () => {
    const m = buildModelFromTemplate({
      businessName: 'No Owner Comp',
      template: getSeedTemplate('full_service_restaurant'),
      scale: {
        seats: 64,
        turnsPerDay: 2,
        addressableTrafficPerQuarter: 180_000,
        captureRate: 0.05,
        price: fromDisplay(42),
      },
      equityInjection: fromDisplay(350_000),
      acknowledgedZeroes: new Set(['og_owner_comp']),
    });
    const result = validateBusinessModel(m);
    expect(result.issues.some((i) => i.code === 'NO_OWNER_COMPENSATION')).toBe(true);
  });

  it('injects maintenance exactly once, from the asset rate', () => {
    const m = model();
    const maintenanceLines = m.costs.fixedPeriod.filter((c) => c.id === 'og_maintenance');
    expect(maintenanceLines).toHaveLength(1);
    // Equipment 4% + leasehold 1.5% + FF&E 3%, quarterly.
    const expected = (180_000 * 0.04 + 250_000 * 0.015 + 90_000 * 0.03) / 4;
    expect(Number(maintenanceLines[0]!.amountPerQuarter) / 100).toBeCloseTo(expected, 2);
    /**
     * "Exactly once" has to mean across mechanisms, not within one. This test
     * counted `og_maintenance` lines while `og_repairs` charged 2% of revenue
     * for the same upkeep under a different id — a vending operator paid a
     * $4.3k/quarter reserve on 40 machines AND the revenue-based line on top.
     * With an asset base, the asset rate is the one mechanism; the
     * revenue-based line must be absent.
     */
    expect(m.costs.variableWithRevenue.find((c) => c.id === 'og_repairs')).toBeUndefined();
  });

  it('falls back to revenue-based repairs only when there are no assets to derive it from', () => {
    const empty = {
      variableWithRevenue: [],
      variableWithActivity: [],
      stepFixed: [],
      fixedPeriod: [],
      payrollLoadPct: 0.12,
    };
    const base = {
      template: getSeedTemplate('full_service_restaurant'),
      archetypes: ['TRAFFIC' as const],
      hasLocation: true,
      hasEmployees: true,
    };

    // Premises but nothing owned: the revenue-based charge is the only source.
    const noAssets = injectOmissionGuardLines(empty, { ...base, assets: [] });
    expect(noAssets.variableWithRevenue.find((c) => c.id === 'og_repairs')).toBeDefined();
    expect(noAssets.fixedPeriod.find((c) => c.id === 'og_maintenance')).toBeUndefined();

    // An asset base switches the mechanism rather than adding a second one.
    const withAssets = injectOmissionGuardLines(empty, {
      ...base,
      assets: [{ grossCost: 10_000_000n, maintenancePctOfGrossPerYear: 0.04 }],
    });
    expect(withAssets.fixedPeriod.find((c) => c.id === 'og_maintenance')).toBeDefined();
    expect(withAssets.variableWithRevenue.find((c) => c.id === 'og_repairs')).toBeUndefined();
  });

  it('folds card mix into the processing rate', () => {
    const m = model();
    const processing = m.costs.variableWithRevenue.find((c) => c.id === 'og_card_processing');
    expect(processing).toBeDefined();
    expect(processing!.pctOfRevenue).toBeCloseTo(0.028 * 0.85, 10);
  });

  it('refuses a zero payroll load (§4.5)', () => {
    const m = model();
    m.costs.payrollLoadPct = 0;
    const result = validateBusinessModel(m);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'ZERO_PAYROLL_LOAD')).toBe(true);
  });
});

describe('model validation rules', () => {
  it('rejects seasonality that does not average 1.00', () => {
    const m = model();
    m.streams[0]!.seasonality = [1.4, 1.4, 1.4, 1.4];
    const result = validateBusinessModel(m);
    expect(result.issues.some((i) => i.code === 'SEASONALITY_NOT_NORMALISED')).toBe(true);
  });

  it('rejects an S-corp with no owner W-2 compensation (§7.1)', () => {
    const m = model();
    m.legalForm = 'S_CORP';
    m.costs.fixedPeriod = m.costs.fixedPeriod.filter((c) => !c.isOwnerComp);
    const result = validateBusinessModel(m);
    expect(result.issues.some((i) => i.code === 'S_CORP_WITHOUT_OWNER_COMP')).toBe(true);
  });

  it('rejects a UTILIZATION stream with no staffed capacity', () => {
    const m = model();
    m.streams[0]!.params = {
      kind: 'UTILIZATION',
      billableHoursPerHeadPerQuarter: 480,
      targetUtilization: 0.7,
      blendedHourlyRate: fromDisplay(150),
      referencePrice: fromDisplay(150),
      realizationRate: 0.9,
      demandHoursPerQuarter: 2000,
    };
    const result = validateBusinessModel(m);
    expect(result.issues.some((i) => i.code === 'UTILIZATION_WITHOUT_STAFFING')).toBe(true);
  });
});

describe('month-zero outlays (§5.4)', () => {
  it('captures every outlay founders routinely forget', () => {
    const outlays = computeMonthZeroOutlays(model());

    // First month + last month + security deposit at the default.
    expect(Number(outlays.leaseSigning) / 100).toBeCloseTo(11_000 * 3, 2);
    expect(outlays.buildoutAndEquipment).toBeGreaterThan(0n);
    expect(outlays.initialInventory).toBeGreaterThan(0n);
    expect(outlays.prepaidInsurance).toBeGreaterThan(0n);
    expect(outlays.preOpeningPayroll).toBeGreaterThan(0n);
    expect(outlays.preOpeningMarketing).toBeGreaterThan(0n);
    expect(outlays.permitsAndLegal).toBeGreaterThan(0n);

    // The headline: a founder who budgeted only for the buildout is short by
    // more than the buildout's own contingency.
    expect(outlays.total).toBeGreaterThan(outlays.buildoutAndEquipment);
  });
});

describe('FREEPLAY capital cap (§16 Q4)', () => {
  it('caps at $1B so the export stays inside safe float range', () => {
    expect(clampFreeplay(fromDisplay(500_000_000))).toBe(fromDisplay(500_000_000));
    expect(clampFreeplay(fromDisplay(10_000_000_000))).toBe(fromDisplay(1_000_000_000));
  });
});

describe('seed templates (§4.7, §12.2)', () => {
  it('every template parses and its monthly weights reconcile to its quarters', () => {
    const templates = listSeedTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(validateMonthlyWeights(template)).toEqual([]);
      const average = template.seasonality.reduce((a, b) => a + b, 0) / 4;
      expect(Math.abs(average - 1), `${template.id} seasonality`).toBeLessThan(0.01);
    }
  });

  it('every template documents a source for each benchmark band', () => {
    for (const template of listSeedTemplates()) {
      for (const cost of template.costDefaults) {
        if (cost.benchmarkBand) {
          expect(cost.benchmarkBand.source.length).toBeGreaterThan(0);
        }
        expect(cost.sourceNote.length).toBeGreaterThan(0);
      }
    }
  });
});
