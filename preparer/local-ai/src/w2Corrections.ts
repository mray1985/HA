/**
 * W-2c corrections (Form W-2c, Rev. January 2026).
 *
 * A W-2c prints only the boxes it corrects, each as previously reported and
 * as corrected. It applies to the W-2 on the case from the same employer (EIN)
 * for the same year: the W-2's own facts stay as read, and the engine item is
 * the W-2 with the corrected boxes. Nothing is applied when the W-2 it
 * corrects is not on the case (a W-2c alone does not give every box), when
 * two W-2s could be meant, or when a "previously reported" amount does not
 * match the W-2 on the case — those go to the preparer.
 */

import { formKeyOf } from './factValidation.js';
import { formFieldValues } from './preparerChoices.js';
import type { TaxFact, TaxFactValue } from './taxFact.js';
import { factPrefixOf, W2C_CORRECTABLE, w2cField, type W2cCorrectable } from './taxTools.js';

export interface ResolvedW2Correction {
  /** The W-2c's form key. */
  formKey: string;
  employerName?: string;
  /** The W-2 it corrects, when exactly one on the case matches. */
  targetKey?: string;
  /** Corrected values by W-2 field. */
  changes: Partial<Record<W2cCorrectable, number | string>>;
  /** True when the W-2c corrects only the SSN or name (box e), no amount. */
  identityOnly: boolean;
  problems: string[];
  ready: boolean;
}

const digits = (v: TaxFactValue | undefined) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

function formsOf(facts: readonly TaxFact[], prefix: string): Map<string, TaxFact[]> {
  const out = new Map<string, TaxFact[]>();
  for (const f of facts) {
    if (!f.factType.startsWith(prefix)) continue;
    out.set(formKeyOf(f), [...(out.get(formKeyOf(f)) ?? []), f]);
  }
  return out;
}

const same = (a: TaxFactValue | undefined, b: TaxFactValue | undefined) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.005 : String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

const money = (v: TaxFactValue | undefined) => (typeof v === 'number' ? v.toLocaleString('en-US', { minimumFractionDigits: 2 }) : String(v));

/** Every W-2c on the case, resolved against the case's W-2s in the order the W-2cs were read. */
export function resolveW2Corrections(facts: readonly TaxFact[], taxYear: number): ResolvedW2Correction[] {
  const w2s = [...formsOf(facts, factPrefixOf('add_w2'))].map(([key, fs]) => ({ key, values: formFieldValues(fs) }));
  // The W-2 values as corrected so far, so a second W-2c checks against the first's result.
  const current = new Map(w2s.map((w) => [w.key, new Map(w.values)]));
  const out: ResolvedW2Correction[] = [];

  for (const [formKey, fs] of formsOf(facts, factPrefixOf('add_w2c'))) {
    const v = formFieldValues(fs);
    const problems: string[] = [];
    const employerName = typeof v.get('employerName') === 'string' ? (v.get('employerName') as string).split(/\r?\n/)[0]!.trim() : undefined;
    const year = v.get('taxYearCorrected');
    if (typeof year === 'number' && year !== taxYear) problems.push(`It corrects a ${year} W-2, not ${taxYear}.`);

    const ein = digits(v.get('employerEin'));
    const spouse = v.get('isSpouse');
    const matches = ein
      ? w2s.filter((w) => digits(w.values.get('employerEin')) === ein && (spouse === undefined || w.values.get('isSpouse') === undefined || w.values.get('isSpouse') === spouse))
      : [];
    if (!ein) problems.push('Its employer EIN was not read, so the W-2 it corrects cannot be found.');
    else if (matches.length === 0) problems.push(`The W-2 it corrects (EIN ${ein}) is not on the case; add the original W-2 — a W-2c alone does not give every box.`);
    else if (matches.length > 1) problems.push(`${matches.length} W-2s from EIN ${ein} are on the case; which one it corrects is not clear.`);

    const target = matches.length === 1 ? matches[0]!.key : undefined;
    const changes: Partial<Record<W2cCorrectable, number | string>> = {};
    for (const field of W2C_CORRECTABLE) {
      const correct = v.get(w2cField('correct', field));
      if (correct === undefined) continue;
      const previous = v.get(w2cField('previous', field));
      const onCase = target ? current.get(target)!.get(field) : undefined;
      if (target && previous !== undefined && onCase !== undefined && !same(previous, onCase)) {
        problems.push(`Its previously reported ${field} (${money(previous)}) does not match the W-2 on the case (${money(onCase)}).`);
      }
      changes[field] = correct as number | string;
    }
    const identityOnly = Object.keys(changes).length === 0 && v.get('correctsSsnOrName') === true;
    if (Object.keys(changes).length === 0 && !identityOnly) problems.push('No corrected amount was read.');

    const ready = problems.length === 0;
    if (ready && target) for (const [field, value] of Object.entries(changes)) current.get(target)!.set(field, value);
    out.push({ formKey, ...(employerName ? { employerName } : {}), ...(target ? { targetKey: target } : {}), changes, identityOnly, problems, ready });
  }
  return out;
}

/** A W-2's tool fields with every ready W-2c correction that names it. */
export function applyW2Corrections(w2FormKey: string, fields: Record<string, unknown>, corrections: readonly ResolvedW2Correction[]): Record<string, unknown> {
  let out = { ...fields };
  for (const c of corrections) {
    if (c.ready && c.targetKey === w2FormKey) out = { ...out, ...c.changes };
  }
  return out;
}
