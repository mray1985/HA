/**
 * Holding period of a sale (IRC §1222; Pub. 544): long-term when the property
 * was held more than one year, counting from the day after it was acquired and
 * including the day it was sold. Property bought January 1 and sold the next
 * January 1 is short-term; sold January 2, long-term.
 */

/** "03/02/2019", "3/2/2019" or "2019-03-02" → UTC date; anything else ("VARIOUS", "INHERITED") → null. */
export function parsePrintedDate(text: string | undefined): Date | null {
  if (!text) return null;
  const t = text.trim();
  let y: number, m: number, d: number;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (us) [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * True for a long-term holding, false for short-term, undefined when either
 * date is not a calendar date or the sale precedes the acquisition.
 */
export function isLongTermHolding(acquired: string | undefined, sold: string | undefined): boolean | undefined {
  const a = parsePrintedDate(acquired);
  const s = parsePrintedDate(sold);
  if (!a || !s || s < a) return undefined;
  // One year of holding ends on the anniversary of the acquisition date
  // (February 28 for property acquired on February 29).
  const leapDay = a.getUTCMonth() === 1 && a.getUTCDate() === 29;
  const anniversary = new Date(Date.UTC(a.getUTCFullYear() + 1, a.getUTCMonth(), leapDay ? 28 : a.getUTCDate()));
  return s > anniversary;
}
