import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFromPDF } from '../services/pdfImporter';
import { TOOL_MAPPINGS, FORM_EXTRACTION_SCHEMAS, type ClassifiableFormType } from '@hatax/local-ai';

const FORMS = '../local-ai/gauntlet/forms';

const cache = new Map<string, string>();

/** The page text, read from the blank itself rather than from anything we authored. */
async function pageTextOf(file: string): Promise<string> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const bytes = new Uint8Array(readFileSync(`${FORMS}/${file}`));
  const r = await extractFromPDF(new File([bytes], file, { type: 'application/pdf' }));
  const text = String((r as unknown as { pageText?: string }).pageText ?? '');
  cache.set(file, text);
  return text;
}

/**
 * What label each box number carries on this form, read off the page.
 *
 * Tokens are walked rather than pattern-matched, because the text layer is one
 * long line: a box number is a bare number token in a plausible box range, and
 * its label runs until the next one. The Part I and Part II column markers - A,
 * B, F1, H2, K3 - are interleaved with the labels and end them too.
 *
 * Labels can carry trailing column text, because the columns are read left to
 * right. Assertions below therefore test a label's opening words rather than the
 * whole run.
 */
function printedLabels(pageText: string): Map<string, string> {
  const tokens = pageText.replace(/\s+/g, ' ').trim().split(' ');
  const isBoxNo = (t: string) => /^\d{1,2}[a-z]?$/.test(t) && Number.parseInt(t, 10) <= 30;
  const isColumnMarker = (t: string) => /^[A-Z][0-9]?$/.test(t);
  const out = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isBoxNo(tokens[i]!)) continue;
    const label: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      if (isBoxNo(tokens[j]!) || isColumnMarker(tokens[j]!)) break;
      label.push(tokens[j]!);
    }
    const text = label.join(' ').replace(/[.*]+$/, '').trim();
    if (text.length >= 4 && !out.has(tokens[i]!)) out.set(tokens[i]!, text);
  }
  return out;
}

/** The opening words of a printed label, lowercased and stripped of punctuation. */
function opening(label: string | undefined, words = 2): string {
  return (label ?? '')
    .toLowerCase()
    .replace(/[(),.*]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join(' ');
}

function k1Schema(): { box: Map<string, string>; mapped: Map<string, string> } {
  const s = FORM_EXTRACTION_SCHEMAS['K-1' as ClassifiableFormType];
  const m = TOOL_MAPPINGS['K-1' as ClassifiableFormType];
  return {
    box: new Map((s?.boxes ?? []).map((b) => [b.key, b.box])),
    mapped: new Map(Object.entries(m?.direct ?? {})),
  };
}

describe('the printed K-1, not the engine comment, says where a box is', () => {
  it('reads the 1120-S box numbers off the blank', async () => {
    const labels = printedLabels(await pageTextOf('f1120ssk.pdf'));
    expect(labels.get('1')).toMatch(/^Ordinary business income/);
    expect(labels.get('4')).toMatch(/^Interest income/);
    expect(labels.get('5a')).toMatch(/^Ordinary dividends/);
    expect(labels.get('6')).toMatch(/^Royalties/);
    expect(labels.get('7')).toMatch(/^Net short-term capital gain/);
    expect(labels.get('8a')).toMatch(/^Net long-term capital gain/);
    expect(labels.get('9')).toMatch(/^Net section 1231 gain/);
    expect(labels.get('10')).toMatch(/^Other income/);
    expect(labels.get('11')).toMatch(/^Section 179 deduction/);
    expect(labels.get('12')).toMatch(/^Other deductions/);
    // Box 14 is a checkbox on an S corporation, not earnings.
    expect(labels.get('14')).toMatch(/^Schedule K-3 is attached/);
  });

  it('reads the 1065 box numbers off the blank', async () => {
    const labels = printedLabels(await pageTextOf('f1065sk1.pdf'));
    expect(labels.get('7')).toMatch(/^Royalties/);
    expect(labels.get('14')).toMatch(/^Self-employment earnings/);
    expect(labels.get('4c')).toMatch(/^Total guaranteed payments/);
    expect(labels.get('12')).toMatch(/^Section 179 deduction/);
  });

  it('prints no self-employment line and no guaranteed payments on the 1120-S', async () => {
    // The strongest fact here needs no label parsing at all: these two strings
    // are on the partnership blank and simply are not on the S corporation's.
    const scorp = (await pageTextOf('f1120ssk.pdf')).toLowerCase();
    const partnership = (await pageTextOf('f1065sk1.pdf')).toLowerCase();
    expect(partnership).toContain('self-employment earnings');
    expect(partnership).toContain('guaranteed payments');
    expect(scorp).not.toContain('self-employment');
    expect(scorp).not.toContain('guaranteed payment');
  });

  it('shows the same number meaning different things on each form', async () => {
    // Each of these is a box where reading the 1120-S through the 1065's map
    // would file a correct-looking number under the wrong meaning.
    const scorp = printedLabels(await pageTextOf('f1120ssk.pdf'));
    const partnership = printedLabels(await pageTextOf('f1065sk1.pdf'));
    for (const [box, onScorp, onPartnership] of [
      ['7', /^Net short-term capital gain/, /^Royalties/],
      ['10', /^Other income/, /^Net section 1231 gain/],
      ['11', /^Section 179 deduction/, /^Other income/],
      ['12', /^Other deductions/, /^Section 179 deduction/],
      ['14', /^Schedule K-3 is attached/, /^Self-employment earnings/],
    ] as [string, RegExp, RegExp][]) {
      expect(scorp.get(box), `1120-S box ${box}`).toMatch(onScorp);
      expect(partnership.get(box), `1065 box ${box}`).toMatch(onPartnership);
    }
  });

  it('places automatically only the boxes both forms print the same', async () => {
    // The guard. Of the boxes the schema maps, the ones both forms print the
    // same are the only ones that may be placed automatically, so an S-corp K-1
    // contributes what is genuinely common and holds everything that is not.
    // Comparing the first two words is coarse but only ever errs toward calling
    // a pair the same, so a box listed as safe here is safe by inspection of the
    // two labels above.
    const scorp = printedLabels(await pageTextOf('f1120ssk.pdf'));
    const partnership = printedLabels(await pageTextOf('f1065sk1.pdf'));
    const { box, mapped } = k1Schema();

    const sameOnBothForms = [...mapped].filter(([key]) => {
      const number = box.get(key);
      if (!number) return false;
      const a = scorp.get(number);
      if (a === undefined) return false;
      return opening(a) === opening(partnership.get(number));
    });

    // Of the boxes the 1065's schema maps, these two are the whole overlap
    // between the forms.
    expect(sameOnBothForms.map(([k]) => k).sort()).toEqual(['1', '2']);

    // The rest are not dropped: they are read through the 1120-S's own map, so
    // what has to be right now is that map, box for box, against the printed
    // page. These keys are the 1120-S's printed box numbers, not the 1065's.
    const mapping = TOOL_MAPPINGS['K-1' as ClassifiableFormType];
    const byScorp = mapping?.byEntityType?.['s_corp']?.direct ?? {};
    expect(Object.keys(byScorp).sort()).toEqual(
      ['1', '10', '11', '2', '4', '5a', '5b', '6', '7', '8a', '8b', '8c', '9', 'a'].sort(),
    );

    // Each mapped number must print what the field it feeds means. The 1065's
    // map would file box 7 as royalties; the blank says short-term gain.
    expect(opening(scorp.get('7')!, 3)).toBe('net short-term capital');
    expect(opening(scorp.get('10')!, 2)).toBe('other income');
    expect(opening(scorp.get('4')!, 2)).toBe('interest income');
    expect(opening(scorp.get('9')!, 3)).toBe('net section 1231');
    expect(opening(scorp.get('11')!, 3)).toBe('section 179 deduction');

    // The printed label is only half the claim: the box number has to be wired
    // to the field that label means. Checking the number and the label alone
    // would pass if box 7 still said "short-term gain" but fed royalties.
    expect(byScorp).toMatchObject({
      '1': 'ordinaryBusinessIncome',
      '2': 'rentalIncome',
      '4': 'interestIncome',
      '5a': 'ordinaryDividends',
      '5b': 'qualifiedDividends',
      '6': 'royalties',
      '7': 'shortTermCapitalGain',
      '8a': 'longTermCapitalGain',
      '8b': 'collectiblesGain28',
      '8c': 'unrecapturedSection1250Gain',
      '9': 'netSection1231Gain',
      '10': 'otherIncome',
      '11': 'section179Deduction',
      a: 'entityEin',
    });

    // And the two boxes a 1120-S does not have must not be reachable at all -
    // there is no box behind them to confirm against.
    expect(byScorp).not.toHaveProperty('4c');
    expect(byScorp).not.toHaveProperty('14');
  });
});