/**
 * Fixtures shared across transport tests.
 *
 * Both transports need the same smallest-valid draft to hand back, and two
 * copies of a fifty-line object drift the moment `zConceptDraft` gains a field.
 */

/** The smallest thing `zConceptDraft` accepts, so the retry has something to return. */
export const MINIMAL_DRAFT = {
  businessName: 'Hemp brand',
  summary: 'DTC and wholesale.',
  legalForm: 'LLC_PASSTHROUGH',
  seedTemplateId: null,
  stream: {
      label: 'Direct sales',
      archetype: 'UNITS_CAC',
      archetypeRationale: 'Units sold, each acquired at a cost.',
      params: [
        { name: 'avgOrderValue', value: 60, low: 45, high: 80, sourceNote: 'Basket.', provenance: 'LLM_ESTIMATE' },
      ],
      seasonality: [1, 1, 1, 1],
      marketingSpendPerQuarter: 40_000,
      expectedAnnualRevenue: 2_000_000,
    },
  costLines: [
    {
      label: 'Product cost',
      class: 'VARIABLE_REVENUE',
      statementLine: 'COGS',
      value: 0.34,
      isLabor: false,
      accruable: true,
      capacityPerBlock: null,
      minimumBlocks: null,
      sourceNote: 'Distillate, hardware, packaging.',
      provenance: 'LLM_ESTIMATE',
    },
  ],
  capex: [
    { label: 'Fill line', category: 'EQUIPMENT', grossCost: 180_000, usefulLifeYears: 7, quantity: 1, sourceNote: 'Quoted.' },
  ],
  workingCapital: {
    dsoDays: 21, dioDays: 45, dpoDays: 30,
    prepaidInsuranceMonths: 6, securityDepositMonths: 2, customerDepositPct: 0,
  },
  overheads: {
    ownerCompPerYear: 90_000, utilitiesPerQuarter: 6_000,
    generalLiabilityInsurancePerYear: 24_000, propertyInsurancePerYear: 6_000,
    accountingAndLegalPerYear: 40_000, softwareAndPosPerYear: 18_000,
    permitsAndLicensesPerYear: 12_000, badDebtPctOfRevenue: 0.01,
    repairsPctOfRevenue: 0.01, cardProcessingRate: 0.045, cardMixPct: 0.95,
    workersCompPct: 0.03, offersBenefits: false, monthlyRent: 9_000,
    preOpeningPayrollAndTraining: 40_000, preOpeningMarketing: 60_000,
    preOpeningPermitsAndLegal: 45_000,
  },
  openNotes: ['Payment processing is the go/no-go item.'],
};
