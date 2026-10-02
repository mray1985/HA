/**
 * Final review package (work order §38): one PDF for the preparer's file —
 * the taxpayer, the income, deduction and credit summaries, the federal and
 * state results, the change from last year, every review item (open, or
 * decided with its note), and where each value came from (the documents and
 * how each was read). Built from the case as it stands; it says whether the
 * case is approved.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { FilingStatus, type CalculationResult, type TaxReturn } from '@hatax/engine';
import { missingDocumentTitle, type IngestedDocument, type MissingDocument } from '@hatax/local-ai';
import type { CaseReview, ReviewItem } from './caseReview';

const PAGE_W = 612;
const PAGE_H = 792;
const M = 50;
const RIGHT = PAGE_W - M;
const INK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const ACCENT = rgb(0.1, 0.3, 0.65);
const BAND = rgb(0.95, 0.95, 0.97);

const STATUS_LABEL: Record<FilingStatus, string> = {
  [FilingStatus.Single]: 'Single',
  [FilingStatus.MarriedFilingJointly]: 'Married filing jointly',
  [FilingStatus.MarriedFilingSeparately]: 'Married filing separately',
  [FilingStatus.HeadOfHousehold]: 'Head of household',
  [FilingStatus.QualifyingSurvivingSpouse]: 'Qualifying surviving spouse',
};

/** The standard fonts encode WinAnsi only: anything else is written plainly. */
export function pdfSafe(text: string): string {
  return text
    .replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/§/g, 'Sec. ')
    .replace(/[^\x20-\x7E\xA0-\xFF—–‘’“”•…]/g, '?');
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

class Writer {
  page: PDFPage;
  y = PAGE_H - M;
  constructor(private doc: PDFDocument, private regular: PDFFont, private bold: PDFFont) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
  }

  private room(height: number) {
    if (this.y - height < M) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - M;
    }
  }

  title(text: string, sub: string) {
    this.page.drawText(pdfSafe(text), { x: M, y: this.y, size: 15, font: this.bold, color: INK });
    this.y -= 18;
    this.page.drawText(pdfSafe(sub), { x: M, y: this.y, size: 9, font: this.regular, color: GRAY });
    this.y -= 20;
  }

  section(text: string) {
    this.room(40);
    this.y -= 6;
    this.page.drawRectangle({ x: M - 5, y: this.y - 4, width: RIGHT - M + 10, height: 18, color: BAND });
    this.page.drawText(pdfSafe(text.toUpperCase()), { x: M, y: this.y, size: 9, font: this.bold, color: ACCENT });
    this.y -= 22;
  }

  row(label: string, value: string, bold = false) {
    this.room(14);
    const font = bold ? this.bold : this.regular;
    const v = pdfSafe(value);
    this.page.drawText(pdfSafe(label), { x: M, y: this.y, size: 9, font, color: INK });
    this.page.drawText(v, { x: RIGHT - font.widthOfTextAtSize(v, 9), y: this.y, size: 9, font, color: INK });
    this.y -= 14;
  }

  /** A paragraph, wrapped to the page. */
  text(text: string, opts: { indent?: number; size?: number; color?: typeof INK; bold?: boolean } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.bold : this.regular;
    const x = M + (opts.indent ?? 0);
    const width = RIGHT - x;
    const words = pdfSafe(text).split(/\s+/);
    let line = '';
    const flush = () => {
      if (!line) return;
      this.room(size + 4);
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
      this.y -= size + 4;
      line = '';
    };
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        flush();
        line = w;
      } else {
        line = next;
      }
    }
    flush();
  }

  gap(n = 6) {
    this.y -= n;
  }
}

export interface ReviewPackageInput {
  taxReturn: TaxReturn;
  calculation: CalculationResult | null;
  review: CaseReview;
  documents: readonly IngestedDocument[];
  missingDocuments: readonly MissingDocument[];
  now?: Date;
}

export async function generateReviewPackagePDF(input: ReviewPackageInput): Promise<Uint8Array> {
  const { taxReturn: tr, calculation, review, documents, missingDocuments } = input;
  const doc = await PDFDocument.create();
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const f = calculation?.form1040;
  const name = [[tr.firstName, tr.middleInitial, tr.lastName, tr.suffix], [tr.spouseFirstName, tr.spouseLastName]]
    .map((p) => p.filter(Boolean).join(' ')).filter(Boolean).join(' & ') || 'New client';
  const status = review.approval
    ? `Approved ${new Date(review.approval.approvedAt).toLocaleString('en-US')}`
    : `Not approved — ${review.open.length} item${review.open.length === 1 ? '' : 's'} open`;
  w.title(`Final review package — ${name}`, `Tax year ${tr.taxYear} · ${status} · built ${(input.now ?? new Date()).toLocaleString('en-US')}`);

  w.section('Taxpayer');
  w.row('Taxpayer', [[tr.firstName, tr.middleInitial, tr.lastName, tr.suffix].filter(Boolean).join(' ') || '—', tr.ssn ? `SSN ending ${tr.ssn.replace(/\D/g, '').slice(-4)}` : 'no SSN'].join(', '));
  if (tr.spouseFirstName || tr.spouseSsn) w.row('Spouse', [[tr.spouseFirstName, tr.spouseLastName].filter(Boolean).join(' ') || '—', tr.spouseSsn ? `SSN ending ${tr.spouseSsn.replace(/\D/g, '').slice(-4)}` : 'no SSN'].join(', '));
  w.row('Filing status', tr.filingStatus ? STATUS_LABEL[tr.filingStatus] : 'Not entered');
  w.row('Address', [tr.addressStreet, tr.addressCity, [tr.addressState, tr.addressZip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || 'Not entered');
  for (const d of tr.dependents ?? []) w.row(`Dependent: ${[d.firstName, d.lastName].filter(Boolean).join(' ')}`, `${d.relationship || 'relationship not entered'}, ${d.monthsLivedWithYou} months at home`);

  if (f) {
    w.section('Income');
    const income: Array<[string, number]> = [
      ['Wages (line 1z)', f.totalWages], ['Taxable interest (line 2b)', f.totalInterest], ['Ordinary dividends (line 3b)', f.totalDividends],
      ['IRA distributions, taxable (line 4b)', f.iraDistributionsTaxable], ['Pensions and annuities, taxable (line 5b)', f.pensionDistributionsTaxable],
      ['Social Security, taxable (line 6b)', f.taxableSocialSecurity], ['Capital gain or loss (line 7)', f.capitalGainOrLoss],
      ['Schedule C net profit', f.scheduleCNetProfit], ['Schedule E', f.scheduleEIncome], ['Unemployment', f.totalUnemployment],
      ['Other income, Schedule 1 (line 8)', f.additionalIncome],
    ];
    for (const [label, n] of income) if (n) w.row(label, money(n));
    w.row('Total income (line 9)', money(f.totalIncome), true);

    w.section('Adjustments and deductions');
    if (f.totalAdjustments) w.row('Adjustments to income (line 10)', money(f.totalAdjustments));
    w.row('Adjusted gross income (line 11)', money(f.agi), true);
    w.row(f.deductionUsed === 'itemized' ? 'Itemized deductions (line 12)' : 'Standard deduction (line 12)', money(f.deductionAmount));
    if (f.qbiDeduction) w.row('Qualified business income deduction (line 13)', money(f.qbiDeduction));
    w.row('Taxable income (line 15)', money(f.taxableIncome), true);

    w.section('Tax, credits and payments');
    w.row('Total tax (line 24)', money(f.totalTax));
    if (f.totalCredits) w.row('Credits', money(f.totalCredits));
    w.row('Total payments (line 33)', money(f.totalPayments));
    w.row(f.refundAmount > 0 ? 'Refund' : f.amountOwed > 0 ? 'Amount owed' : 'Balance', money(f.refundAmount > 0 ? f.refundAmount : f.amountOwed), true);
  }

  if ((calculation?.stateResults ?? []).length > 0) {
    w.section('State');
    for (const s of calculation!.stateResults!) {
      w.row(`${s.stateName}${s.unsupported?.length ? ' (not supported)' : ''}`, s.stateRefundOrOwed >= 0 ? `refund ${money(s.stateRefundOrOwed)}` : `owes ${money(-s.stateRefundOrOwed)}`);
    }
  }

  const prior = tr.priorYearSummary;
  if (prior && f) {
    w.section(`Change from ${prior.taxYear}`);
    const pct = (now: number, before: number) => (before ? ` (${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%)` : '');
    w.row('Adjusted gross income', `${money(prior.agi)} -> ${money(f.agi)}${pct(f.agi, prior.agi)}`);
    if (prior.totalWages !== undefined) w.row('Wages', `${money(prior.totalWages)} -> ${money(f.totalWages)}${pct(f.totalWages, prior.totalWages)}`);
    w.row('Total tax', `${money(prior.totalTax)} -> ${money(f.totalTax)}`);
    w.row('Refund or owed', `${prior.refundAmount > 0 ? `refund ${money(prior.refundAmount)}` : `owed ${money(prior.amountOwed)}`} -> ${f.refundAmount > 0 ? `refund ${money(f.refundAmount)}` : `owed ${money(f.amountOwed)}`}`);
  }

  w.section(`Review — ${review.open.length} open`);
  const line = (i: ReviewItem) => `[${i.category}] ${i.message}${i.resolution ? ` — ${i.resolution.decision === 'accepted' ? 'Checked' : 'Not applicable'}: ${i.resolution.note}` : ''}`;
  const open = review.items.filter((i) => i.category !== 'INFORMATIONAL' && !i.resolution);
  const decided = review.items.filter((i) => i.resolution);
  if (open.length === 0) w.text('Nothing is open.', { color: GRAY });
  for (const i of open) w.text(line(i), { indent: 6 });
  if (decided.length > 0) {
    w.gap();
    w.text('Decided by the preparer:', { bold: true });
    for (const i of decided) w.text(line(i), { indent: 6 });
  }

  w.section('Sources');
  const onCase = documents.filter((d) => d.status !== 'duplicate' && d.status !== 'rejected');
  w.text(`${onCase.filter((d) => d.status === 'extracted').length} of ${onCase.length} documents read.`, { color: GRAY });
  for (const d of onCase) {
    const forms = (d.formTypes ?? []).join(', ') || (d.status === 'unclassified' ? 'not identified' : 'not read');
    w.text(`${d.fileName} — ${forms}${d.extractor ? `, read by ${d.extractor}` : ''} (SHA-256 ${d.contentHash.slice(0, 12)}…)`, { indent: 6 });
  }
  const missing = missingDocuments.filter((m) => m.status !== 'client_says_none');
  if (missing.length > 0) {
    w.gap();
    w.text('Possibly missing:', { bold: true });
    for (const m of missing) w.text(`${missingDocumentTitle(m)} — ${m.lastYear}`, { indent: 6 });
  }
  w.gap(10);
  w.text('Every value above comes from the case’s documents, the preparer’s entries and decisions, and the HA Tax engine; the case’s audit trail records each one.', { size: 8, color: GRAY });
  return doc.save();
}
