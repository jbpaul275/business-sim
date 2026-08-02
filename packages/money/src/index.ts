/**
 * Money — integer minor units (cents) as `bigint`. Spec §2.7.
 *
 * Zero dependencies, by design. This package is the bottom of the stack and the
 * single place rounding happens.
 *
 * The rule that makes the rest of the engine trustworthy: a float becomes money
 * only through `mulRate` or `divRate`. There is no other conversion path.
 * Quantities (transactions, hours, customers) stay floats and are never rounded
 * — 4,183.7 transactions is a meaningful expected value in a deterministic
 * model, and rounding it every period compounds error across 40 periods.
 * Round at the money boundary, once, half-away-from-zero.
 */

export type Money = bigint;

export const ZERO: Money = 0n;
export const CENTS_PER_UNIT = 100n;

/** Days in a quarter, for working-capital day conversions. Spec §2.1. */
export const DAYS_PER_QUARTER = 91.25;
export const QUARTERS_PER_YEAR = 4;

// ---------------------------------------------------------------------------
// Exact float → rational
// ---------------------------------------------------------------------------

/**
 * Decompose an IEEE-754 double into an exact rational `num / den`.
 *
 * Doubles are exactly representable as m × 2^e, so this loses nothing. The
 * naive alternative — `BigInt(Math.round(r * 1e9))` — introduces a relative
 * error that is invisible in a unit test and accumulates over a 40-period run.
 * Since the whole point of the bigint decision is that currency arithmetic is
 * exact, the float side of the multiplication should be exact too.
 */
function exactRational(x: number): { num: bigint; den: bigint } {
  if (!Number.isFinite(x)) {
    throw new RangeError(`Rate must be finite, got ${x}`);
  }
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) {
    return { num: BigInt(x), den: 1n };
  }

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);

  const negative = (bits >> 63n) & 1n;
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & 0x000f_ffff_ffff_ffffn;

  let num: bigint;
  let den: bigint;

  if (biasedExponent === 0) {
    // Subnormal: value = mantissa × 2^-1074
    num = mantissa;
    den = 1n << 1074n;
  } else {
    // Normal: value = (2^52 | mantissa) × 2^(biasedExponent - 1075)
    num = mantissa | (1n << 52n);
    const exponent = biasedExponent - 1075;
    if (exponent >= 0) {
      num <<= BigInt(exponent);
      den = 1n;
    } else {
      den = 1n << BigInt(-exponent);
    }
  }

  return { num: negative ? -num : num, den };
}

/** Divide, rounding halves away from zero. `den` must be positive. */
function divRoundHalfAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError('Division by zero');
  if (den < 0n) return divRoundHalfAwayFromZero(-num, -den);

  const quotient = num / den; // bigint division truncates toward zero
  const remainder = num % den;
  if (remainder === 0n) return quotient;

  const twiceRemainder = remainder < 0n ? -remainder * 2n : remainder * 2n;
  if (twiceRemainder >= den) {
    return num < 0n ? quotient - 1n : quotient + 1n;
  }
  return quotient;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export const add = (a: Money, b: Money): Money => a + b;
export const sub = (a: Money, b: Money): Money => a - b;
export const neg = (a: Money): Money => -a;
export const abs = (a: Money): Money => (a < 0n ? -a : a);
export const isZero = (a: Money): boolean => a === 0n;
export const isNegative = (a: Money): boolean => a < 0n;
export const isPositive = (a: Money): boolean => a > 0n;

export const sum = (values: readonly Money[]): Money =>
  values.reduce<Money>((acc, v) => acc + v, ZERO);

export const min = (a: Money, b: Money): Money => (a < b ? a : b);
export const max = (a: Money, b: Money): Money => (a > b ? a : b);
export const clampNonNegative = (a: Money): Money => (a < 0n ? ZERO : a);

/**
 * Multiply money by a float rate or quantity. THE conversion boundary.
 *
 * `mulRate(avgTicket, 4183.7)` — revenue from a fractional transaction count.
 * `mulRate(revenue, 0.30)` — a percentage of revenue.
 *
 * Both are the same operation and both round exactly once, here.
 */
export function mulRate(amount: Money, rate: number): Money {
  if (rate === 0) return ZERO;
  if (rate === 1) return amount;
  const { num, den } = exactRational(rate);
  return divRoundHalfAwayFromZero(amount * num, den);
}

/** Divide money by a float. Same rounding contract as `mulRate`. */
export function divRate(amount: Money, divisor: number): Money {
  if (divisor === 0) throw new RangeError('Division by zero');
  if (divisor === 1) return amount;
  const { num, den } = exactRational(divisor);
  return divRoundHalfAwayFromZero(amount * den, num);
}

/** Alias for `mulRate` that reads better at percentage call sites. */
export const pct = mulRate;

/**
 * Money ÷ money as a float. For ratios and display metrics ONLY — margins,
 * DSCR, occupancy. Never feed the result back into a posted amount without
 * going through `mulRate`.
 */
export function ratio(numerator: Money, denominator: Money): number {
  if (denominator === 0n) return 0;
  return Number(numerator) / Number(denominator);
}

/** Split `amount` into `parts` pieces that sum exactly to `amount`. */
export function allocate(amount: Money, parts: number): Money[] {
  if (parts <= 0 || !Number.isInteger(parts)) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const n = BigInt(parts);
  const base = amount / n;
  let remainder = amount - base * n;
  const step = remainder < 0n ? -1n : 1n;
  const out: Money[] = [];
  for (let i = 0; i < parts; i++) {
    if (remainder !== 0n) {
      out.push(base + step);
      remainder -= step;
    } else {
      out.push(base);
    }
  }
  return out;
}

/**
 * Split `amount` in proportion to `weights`, with the residual assigned to the
 * largest weight so the pieces sum exactly to `amount`. Used wherever a shared
 * pool is divided — capacity allocation across streams, cost allocation.
 */
export function allocateByWeight(amount: Money, weights: readonly number[]): Money[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (total <= 0) return allocate(amount, weights.length);

  const out = weights.map((w) => mulRate(amount, w / total));
  const residual = amount - sum(out);
  if (residual !== 0n) {
    let largest = 0;
    for (let i = 1; i < weights.length; i++) {
      if ((weights[i] ?? 0) > (weights[largest] ?? 0)) largest = i;
    }
    out[largest] = (out[largest] ?? ZERO) + residual;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion and display
// ---------------------------------------------------------------------------

/**
 * Build money from a display value: `fromDisplay(100_000)` → $100,000.00.
 * Strings are parsed exactly (no float round-trip); numbers go through the
 * exact-rational path.
 */
export function fromDisplay(value: number | string): Money {
  if (typeof value === 'string') return parseDecimalString(value);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot convert ${value} to Money`);
  }
  return mulRate(CENTS_PER_UNIT, value);
}

/** Build money from an exact integer count of cents. */
export function fromCents(cents: number | bigint | string): Money {
  if (typeof cents === 'bigint') return cents;
  if (typeof cents === 'string') {
    if (!/^-?\d+$/.test(cents.trim())) {
      throw new RangeError(`Not an integer cent string: "${cents}"`);
    }
    return BigInt(cents.trim());
  }
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Cents must be an integer, got ${cents}`);
  }
  return BigInt(cents);
}

function parseDecimalString(input: string): Money {
  const trimmed = input.trim().replace(/[$,_\s]/g, '');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new RangeError(`Cannot parse money from "${input}"`);
  }
  const [, sign = '', whole = '', frac = ''] = match;
  const centsDigits = (frac + '00').slice(0, 2);
  // Round the third decimal half-away-from-zero rather than truncating.
  const third = frac.length > 2 ? Number(frac[2]) : 0;
  let cents = BigInt(whole || '0') * CENTS_PER_UNIT + BigInt(centsDigits);
  if (third >= 5) cents += 1n;
  return sign === '-' ? -cents : cents;
}

/** Canonical serialisation: a string of integer cents. Spec-safe for JSON. */
export const toCentsString = (amount: Money): string => amount.toString();

/** `$1,234.56`. Display only. */
export function toDisplay(
  amount: Money,
  options: { currency?: string; showCents?: boolean } = {},
): string {
  const { currency = '$', showCents = true } = options;
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const whole = magnitude / CENTS_PER_UNIT;
  const cents = magnitude % CENTS_PER_UNIT;
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = showCents
    ? `${groupedWhole}.${cents.toString().padStart(2, '0')}`
    : groupedWhole;
  return `${negative ? '-' : ''}${currency}${body}`;
}

/** `$1.2M`. For dense statement views. */
export function toCompact(amount: Money): string {
  const units = Number(amount) / 100;
  const magnitude = Math.abs(units);
  const sign = units < 0 ? '-' : '';
  if (magnitude >= 1_000_000_000) return `${sign}$${(magnitude / 1e9).toFixed(1)}B`;
  if (magnitude >= 1_000_000) return `${sign}$${(magnitude / 1e6).toFixed(1)}M`;
  if (magnitude >= 1_000) return `${sign}$${(magnitude / 1e3).toFixed(1)}k`;
  return `${sign}$${magnitude.toFixed(0)}`;
}

/** Shorthand for literals in seed data and tests: `usd(4.50)` → 450n. */
export const usd = fromDisplay;
