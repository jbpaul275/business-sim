/**
 * Live comma grouping for dollar inputs. "500000" is a count-the-zeros
 * exercise; "500,000" is a number. State keeps the formatted string; parsing
 * strips the commas back out at the edge.
 */

/** Whole-dollar input: digits in, grouped digits out. */
export const groupDigits = (raw: string): string => {
  const clean = raw.replace(/[^0-9]/g, '');
  return clean === '' ? '' : Number(clean).toLocaleString('en-US');
};

/** Price input: same, but allows one decimal point and two places. */
export const groupMoney = (raw: string): string => {
  const clean = raw.replace(/[^0-9.]/g, '');
  const dot = clean.indexOf('.');
  const int = dot === -1 ? clean : clean.slice(0, dot);
  const dec = dot === -1 ? '' : clean.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  const grouped = int === '' ? '' : Number(int).toLocaleString('en-US');
  return dot === -1 ? grouped : `${grouped}.${dec}`;
};

/** Back to a number, for the request body. */
export const ungroup = (formatted: string): number => Number(formatted.replace(/,/g, ''));
