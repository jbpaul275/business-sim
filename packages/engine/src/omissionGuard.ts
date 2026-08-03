import { mulRate, sum, type Money } from '@bizsim/money';
import {
  type Archetype,
  type CostStructure,
  type FixedPeriodCost,
  type SeedTemplate,
  type VariableRevenueCost,
} from '@bizsim/schemas';

/**
 * The omission guard — spec §4.6.
 *
 * At concept lock the engine injects these lines into every business unless the
 * player EXPLICITLY acknowledges and zeroes each one. The acknowledgment is
 * recorded in the assumption register as `PLAYER_ASSUMED` and flagged in the
 * export.
 *
 * Owner compensation is the most important line here. Without it every model
 * shows phantom profit because the founder is working free, and the resulting
 * projection is not comparable to a job offer.
 *
 * The LLM must NOT emit these lines (§11.2) — emitting them causes duplicates.
 */

export interface OmissionGuardInput {
  template: SeedTemplate;
  archetypes: readonly Archetype[];
  hasLocation: boolean;
  hasEmployees: boolean;
  assets: readonly { grossCost: Money; maintenancePctOfGrossPerYear: number }[];
  /** Lines the player explicitly zeroed, by id. */
  acknowledgedZeroes?: ReadonlySet<string>;
}

const perQuarter = (annual: Money): Money => mulRate(annual, 0.25);

export function injectOmissionGuardLines(
  costs: CostStructure,
  input: OmissionGuardInput,
): CostStructure {
  const t = input.template;
  const zeroed = input.acknowledgedZeroes ?? new Set<string>();
  const fixed: FixedPeriodCost[] = [];
  const variable: VariableRevenueCost[] = [];

  const addFixed = (
    id: string,
    label: string,
    amountPerQuarter: Money,
    statementLine: FixedPeriodCost['statementLine'],
    extra: Partial<FixedPeriodCost> = {},
  ): void => {
    if (zeroed.has(id)) return;
    fixed.push({
      id,
      label,
      class: 'FIXED_PERIOD',
      amountPerQuarter,
      annualEscalatorPct: 0.02,
      startPeriod: 0,
      renewalBehavior: 'AUTO_RENEW_AT_ESCALATOR',
      statementLine,
      accruable: true,
      isLabor: false,
      isOwnerComp: false,
      isPrepaidExpense: false,
      ...extra,
    });
  };

  const addVariable = (
    id: string,
    label: string,
    pctOfRevenue: number,
    statementLine: VariableRevenueCost['statementLine'],
  ): void => {
    if (zeroed.has(id) || pctOfRevenue <= 0) return;
    variable.push({
      id,
      label,
      class: 'VARIABLE_REVENUE',
      pctOfRevenue,
      appliesToStreamIds: 'ALL',
      statementLine,
      accruable: true,
    });
  };

  addFixed('og_owner_comp', 'Owner compensation', perQuarter(t.ownerCompPerYear), 'G&A', {
    isLabor: true,
    isOwnerComp: true,
    accruable: false,
  });

  /**
   * Maintenance has exactly one mechanism — and for years it had two. The
   * asset-based reserve below AND a revenue-based "Repairs & maintenance" line
   * were both injected for any business with a location and assets, which is
   * nearly every business: a vending operator was paying a $4.3k/quarter
   * reserve on 40 machines and 2% of revenue on top of it, two names for the
   * upkeep of the same equipment. The comment on this block claimed one
   * mechanism the whole time.
   *
   * The rule now: assets are the preferred source, because the rate is per
   * asset class and scales with what the player actually owns rather than
   * with what they happen to sell. The revenue-based line exists only as the
   * fallback for a business with premises but no owned assets to derive a
   * charge from. Never both.
   *
   * "Reserve" is a label, not fund accounting — the charge is expensed as
   * cash every quarter and no reserve balance exists anywhere in the model.
   */
  const maintenance = sum(
    input.assets.map((a) => mulRate(a.grossCost, a.maintenancePctOfGrossPerYear / 4)),
  );
  if (maintenance > 0n) {
    addFixed('og_maintenance', 'Repairs & maintenance (of owned assets)', maintenance, 'G&A');
  }

  addFixed(
    'og_general_liability',
    'General liability insurance',
    perQuarter(t.generalLiabilityInsurancePerYear),
    'G&A',
    { isPrepaidExpense: true },
  );

  if (input.hasLocation) {
    addFixed(
      'og_property_insurance',
      'Property & contents insurance',
      perQuarter(t.propertyInsurancePerYear),
      'OCCUPANCY',
      { isPrepaidExpense: true },
    );
    addFixed('og_utilities', 'Utilities', t.utilitiesPerQuarter, 'OCCUPANCY');
    // The fallback half of the one-mechanism rule above: a revenue-based
    // repairs charge only where there is no asset base to derive one from.
    if (maintenance === 0n) {
      addVariable('og_repairs', 'Repairs & maintenance', t.repairsPctOfRevenue, 'OCCUPANCY');
    }
  }

  addFixed(
    'og_accounting_legal',
    'Accounting & legal',
    perQuarter(t.accountingAndLegalPerYear),
    'G&A',
  );
  addFixed('og_software', 'Software, POS & subscriptions', perQuarter(t.softwareAndPosPerYear), 'G&A');
  addFixed('og_permits', 'Permits & licenses', perQuarter(t.permitsAndLicensesPerYear), 'G&A');

  const takesCards =
    input.archetypes.includes('TRAFFIC') || input.archetypes.includes('UNITS_CAC');
  if (takesCards) {
    // Card mix is folded into the rate at injection time, and the two drivers
    // are registered as separate challengeable assumptions so the player can
    // argue either (§4.1).
    addVariable(
      'og_card_processing',
      'Credit card processing',
      t.cardProcessingRate * t.cardMixPct,
      'G&A',
    );
  }

  const hasBadDebt =
    input.archetypes.includes('TRAFFIC') || input.archetypes.includes('OCCUPANCY');
  if (hasBadDebt) {
    addVariable('og_bad_debt', 'Bad debt & shrinkage', t.badDebtPctOfRevenue, 'G&A');
  }

  return {
    ...costs,
    variableWithRevenue: [...costs.variableWithRevenue, ...variable],
    fixedPeriod: [...costs.fixedPeriod, ...fixed],
  };
}

/** Re-exported: the canonical definition now sits beside its components. */
export { payrollLoadPct } from '@bizsim/schemas';
