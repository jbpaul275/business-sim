import { fromDisplay, type Money } from '@bizsim/money';
import { setAtPath } from '@bizsim/engine';
import { findCatalogItem } from '@bizsim/seeds';
import { adjudicate, type AdjudicationTransport, type Settlement } from '@bizsim/llm';
import { benchmarkDeviation, isWellSourced, type Assumption } from '@bizsim/schemas';

/**
 * One challenge, from claim to write-through — the §11.3 contract with the
 * mechanics attached, shared by every frontend.
 *
 * This existed only inside the CLI's challenge loop, interleaved with prompts
 * and console colours, which meant the web register could show an out-of-band
 * assumption but not argue with it. The contract is the product's signature
 * mechanic; it cannot be terminal-only. Extracted verbatim: adjudication
 * through `adjudicate` (isolated from any conversational thread — the
 * isolation IS the mechanism), then the write-through that PR #4 established:
 * the register is a record OF the model, so both move or neither does.
 */

/**
 * Worth arguing with first: furthest out of band, then the biggest money.
 *
 * Dollar magnitude as the second sort is load-bearing: on a synthetic concept
 * every deviation is zero, and an alphabetical tiebreak led a $4M model with
 * "Accounting & legal $1,500" while a $3.26M capex sat unshown.
 */
export function arguableAssumptions(
  assumptions: readonly Assumption[],
  limit = 12,
): Assumption[] {
  const dollars = (a: Assumption): number => (typeof a.value === 'bigint' ? Number(a.value) : 0);
  return [...assumptions]
    .filter((a) => a.outsideBenchmark || !isWellSourced(a.provenance))
    .sort(
      (a, b) =>
        Math.abs(b.benchmarkDeviation ?? 0) - Math.abs(a.benchmarkDeviation ?? 0) ||
        dollars(b) - dollars(a) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit);
}

/** The shape `setAtPath` writes into — a `BusinessModel` or a live `Business`. */
type WriteTarget = Parameters<typeof setAtPath>[0];

export interface ArgueOutcome {
  settlement: Settlement;
  /** False when the ruling was UNCHANGED, or the register path failed to resolve. */
  applied: boolean;
  /** The path no longer resolves — a bug surfaced softly rather than thrown. */
  pathBroken: boolean;
  /** What the assumption is now worth, applied or not. */
  resultingValue: number | Money;
}

export interface ArgueRequest {
  /** Absent means offline adjudication: recorded, clamped by rule 1, never argued. */
  transport?: AdjudicationTransport | undefined;
  /** Mutated on apply: value, provenance, history, deviation. */
  target: Assumption;
  /** The model or business the assumption is a record of. */
  writeTo: WriteTarget;
  asserted: number | Money;
  basis: string;
  archetype: string;
  businessName: string;
  /** 0 during setup; the current period in a live game. */
  period?: number;
  /** The operator's stated years in this concept's domain (07, stage 4). */
  operatorYears?: number;
}

export async function argueAssumption(request: ArgueRequest): Promise<ArgueOutcome> {
  const { target } = request;
  const asNumber = (v: number | Money): number => (typeof v === 'bigint' ? Number(v) / 100 : v);
  const catalog = findCatalogItem(target.label);

  const settlement = await adjudicate(request.transport, {
    assumption: {
      label: target.label,
      value: asNumber(target.value),
      unit: target.unit,
      range: { low: asNumber(target.range.low), high: asNumber(target.range.high) },
      sourceNote: target.sourceNote,
      provenance: target.provenance,
      benchmarkBand: target.benchmarkBand
        ? { low: target.benchmarkBand.low, high: target.benchmarkBand.high }
        : null,
    },
    playerClaim: {
      assertedValue: asNumber(request.asserted),
      statedBasis: request.basis.trim() === '' ? null : request.basis.trim(),
      evidenceUrl: null,
      operatorYears: request.operatorYears ?? 0,
    },
    businessContext: {
      archetype: request.archetype,
      summary: request.businessName,
    },
    catalogEntry: catalog
      ? {
          label: catalog.label,
          low: catalog.low,
          high: catalog.high,
          tiers: catalog.tiers,
          source: catalog.source,
        }
      : null,
  });

  if (settlement.provenance === 'UNCHANGED') {
    return { settlement, applied: false, pathBroken: false, resultingValue: target.value };
  }

  const landed: number | Money = target.isMoney ? fromDisplay(settlement.value) : settlement.value;
  // The register is a record OF the model, so both move or neither does.
  if (!setAtPath(request.writeTo, target.path, landed)) {
    return { settlement, applied: false, pathBroken: true, resultingValue: target.value };
  }

  target.challengeHistory.push({
    period: request.period ?? 0,
    priorValue: target.value,
    assertedValue: request.asserted,
    statedBasis: request.basis.trim() === '' ? null : request.basis.trim(),
    ruling: settlement.ruling,
    resultingValue: landed,
    reasoning: settlement.reasoning,
  });
  target.value = landed;
  target.provenance = settlement.provenance;
  // §10.5: re-test against the band at the moment of change, not next tick.
  const numeric = asNumber(landed);
  target.outsideBenchmark = target.benchmarkBand
    ? numeric < target.benchmarkBand.low || numeric > target.benchmarkBand.high
    : false;
  const deviation = benchmarkDeviation(target);
  if (deviation !== undefined) target.benchmarkDeviation = deviation;
  else delete target.benchmarkDeviation;

  return { settlement, applied: true, pathBroken: false, resultingValue: landed };
}
