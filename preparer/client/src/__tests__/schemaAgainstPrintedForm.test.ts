import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLASSIFIABLE_FORM_TYPES, type ClassifiableFormType } from '@hatax/local-ai';

const FORMS = '../local-ai/gauntlet/forms';

/**
 * The blank each classifiable form is checked against.
 *
 * A K-1 lists both: the two forms number their boxes differently, and the map
 * used for each is chosen by the printed form number rather than by the form
 * type.
 */
const PRINTED: Partial<Record<ClassifiableFormType, string[]>> = {
  'W-2': ['fw2.pdf'],
  'W-2C': ['fw2c.pdf'],
  'W-2G': ['fw2g.pdf'],
  '1099-INT': ['f1099int.pdf'],
  '1099-DIV': ['f1099div.pdf'],
  '1099-NEC': ['f1099nec.pdf'],
  '1099-R': ['f1099r.pdf'],
  '1099-MISC': ['f1099msc.pdf'],
  '1099-G': ['f1099g.pdf'],
  '1099-B': ['f1099b.pdf'],
  '1099-K': ['f1099k.pdf'],
  '1099-OID': ['f1099oid.pdf'],
  '1099-SA': ['f1099sa.pdf'],
  '1099-Q': ['f1099q.pdf'],
  '1099-C': ['f1099c.pdf'],
  '1099-S': ['f1099s.pdf'],
  '1098': ['f1098.pdf'],
  '1098-T': ['f1098t.pdf'],
  '1098-E': ['f1098e.pdf'],
  '1095-A': ['f1095a.pdf'],
  'K-1': ['f1065sk1.pdf', 'f1120ssk.pdf'],
};

/**
 * Forms with no published blank to check against, and why.
 *
 * SSA-1099 is the only one: the IRS does not publish a fillable SSA-1099 blank
 * from irs.gov, so there is no fixture. It is listed rather than skipped so the
 * guard covers every form, and so a *new* form without a blank fails here with
 * a stated reason instead of quietly passing.
 */
const NO_PRINTED_BLANK: Partial<Record<ClassifiableFormType, string>> = {
  'SSA-1099': 'the IRS does not publish a fillable SSA-1099 blank',
};

describe('every classifiable form has a printed page behind it', () => {
  it('is either mapped to a blank on disk, or listed with a reason', () => {
    // The 1120-S was added as a fixture and read by no test at all for a while,
    // which is how a wrong box map shipped. A new form without a blank fails
    // here instead.
    const uncovered = CLASSIFIABLE_FORM_TYPES.filter((f) => !PRINTED[f] && !NO_PRINTED_BLANK[f]);
    expect(uncovered).toEqual([]);

    // And nothing is mapped to a file that is not there.
    const missing: string[] = [];
    for (const files of Object.values(PRINTED)) {
      for (const file of files!) {
        try {
          readFileSync(`${FORMS}/${file}`);
        } catch {
          missing.push(file);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});