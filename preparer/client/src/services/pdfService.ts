import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, RGB } from 'pdf-lib';
import type { StateCalculationResult } from '@hatax/engine';

// ─── Colors ─────────────────────────────────────────
const BLACK = rgb(0, 0, 0);
const LIGHT_GRAY = rgb(0.6, 0.6, 0.6);
const LINE_COLOR = rgb(0.85, 0.85, 0.85);
const HEADER_BG = rgb(0.95, 0.95, 0.97);
const ACCENT = rgb(0.1, 0.3, 0.65);
const MONEY_GREEN = rgb(0.0, 0.5, 0.2);
const MONEY_RED = rgb(0.7, 0.1, 0.1);

// ─── Layout constants ───────────────────────────────
const PAGE_W = 612;  // Letter width
const PAGE_H = 792;  // Letter height
const MARGIN_L = 50;
const MARGIN_R = 50;
const MARGIN_T = 50;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const COL_RIGHT = PAGE_W - MARGIN_R;

// ─── Types ──────────────────────────────────────────
interface Cursor {
  y: number;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

// ─── Helpers ────────────────────────────────────────
function fmt(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${str})` : str;
}

function fmtDollar(n: number): string {
  return `$${fmt(n)}`;
}

// ─── Drawing primitives ─────────────────────────────

function drawSectionHeader(page: PDFPage, fonts: Fonts, cursor: Cursor, title: string) {
  cursor.y -= 8;
  page.drawRectangle({
    x: MARGIN_L - 5,
    y: cursor.y - 4,
    width: CONTENT_W + 10,
    height: 20,
    color: HEADER_BG,
  });
  page.drawText(title.toUpperCase(), {
    x: MARGIN_L,
    y: cursor.y,
    size: 9,
    font: fonts.bold,
    color: ACCENT,
  });
  cursor.y -= 22;
}

function drawLine(page: PDFPage, cursor: Cursor) {
  page.drawLine({
    start: { x: MARGIN_L, y: cursor.y },
    end: { x: COL_RIGHT, y: cursor.y },
    thickness: 0.5,
    color: LINE_COLOR,
  });
}

function drawRow(
  page: PDFPage,
  fonts: Fonts,
  cursor: Cursor,
  label: string,
  value: string,
  options?: { bold?: boolean; indent?: number; lineNum?: string; color?: RGB },
) {
  const x = MARGIN_L + (options?.indent || 0);
  const font = options?.bold ? fonts.bold : fonts.regular;
  const color = options?.color || BLACK;

  if (options?.lineNum) {
    page.drawText(options.lineNum, {
      x: MARGIN_L,
      y: cursor.y,
      size: 7,
      font: fonts.regular,
      color: LIGHT_GRAY,
    });
  }

  page.drawText(label, {
    x: options?.lineNum ? x + 20 : x,
    y: cursor.y,
    size: 9,
    font,
    color,
  });

  const valWidth = font.widthOfTextAtSize(value, 9);
  page.drawText(value, {
    x: COL_RIGHT - valWidth,
    y: cursor.y,
    size: 9,
    font,
    color,
  });

  cursor.y -= 15;
}

function drawSubtotalRow(
  page: PDFPage,
  fonts: Fonts,
  cursor: Cursor,
  label: string,
  value: string,
  color?: RGB,
) {
  drawLine(page, cursor);
  cursor.y -= 5;
  drawRow(page, fonts, cursor, label, value, { bold: true, color });
  cursor.y -= 3;
}

// ─── Main PDF generators ────────────────────────────

export async function generateStateTaxSummaryPDF(
  sr: StateCalculationResult,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const fonts: Fonts = { regular, bold, italic };

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const cursor: Cursor = { y: PAGE_H - MARGIN_T };

  // ─── Title ──────────────────────────
  page.drawText(`State Tax Summary — ${sr.stateName}`, {
    x: MARGIN_L,
    y: cursor.y,
    size: 14,
    font: bold,
    color: ACCENT,
  });
  cursor.y -= 18;

  const residencyLabel = sr.residencyType === 'resident' ? 'Full-year resident'
    : sr.residencyType === 'part_year' ? 'Part-year resident' : 'Nonresident';
  page.drawText(`${sr.stateCode}  |  ${residencyLabel}  |  Prepared by HA Tax`, {
    x: MARGIN_L,
    y: cursor.y,
    size: 8,
    font: italic,
    color: LIGHT_GRAY,
  });
  cursor.y -= 6;
  drawLine(page, cursor);
  cursor.y -= 12;

  // ─── Income Computation ──────────────
  drawSectionHeader(page, fonts, cursor, 'Income Computation');

  drawRow(page, fonts, cursor, 'Federal AGI', fmtDollar(sr.federalAGI));
  if (sr.stateAdditions > 0) {
    drawRow(page, fonts, cursor, 'State additions', `+${fmtDollar(sr.stateAdditions)}`);
  }
  if (sr.stateSubtractions > 0) {
    drawRow(page, fonts, cursor, 'State subtractions', `(${fmtDollar(sr.stateSubtractions)})`);
  }
  drawSubtotalRow(page, fonts, cursor, 'State AGI', fmtDollar(sr.stateAGI));

  if (sr.stateDeduction > 0) {
    drawRow(page, fonts, cursor, 'Deduction', `(${fmtDollar(sr.stateDeduction)})`);
  }
  if (sr.stateExemptions > 0) {
    drawRow(page, fonts, cursor, 'Exemptions', `(${fmtDollar(sr.stateExemptions)})`);
  }
  drawSubtotalRow(page, fonts, cursor, 'State taxable income', fmtDollar(sr.stateTaxableIncome));

  // ─── Tax Computation ─────────────────
  drawSectionHeader(page, fonts, cursor, 'Tax Computation');

  drawRow(page, fonts, cursor, 'State income tax', fmtDollar(sr.stateIncomeTax));
  if (sr.stateCredits > 0) {
    drawRow(page, fonts, cursor, 'State credits', `(${fmtDollar(sr.stateCredits)})`, { color: MONEY_GREEN });
  }
  if (sr.localTax > 0) {
    drawRow(page, fonts, cursor, 'Local tax', fmtDollar(sr.localTax));
  }
  drawSubtotalRow(page, fonts, cursor, 'Total state tax', fmtDollar(sr.totalStateTax));

  // ─── Payments ────────────────────────
  drawSectionHeader(page, fonts, cursor, 'Payments');

  if (sr.stateWithholding > 0) {
    drawRow(page, fonts, cursor, 'State withholding', fmtDollar(sr.stateWithholding));
  }
  if (sr.stateEstimatedPayments > 0) {
    drawRow(page, fonts, cursor, 'Estimated payments', fmtDollar(sr.stateEstimatedPayments));
  }

  // ─── Refund / Owed ───────────────────
  cursor.y -= 8;
  page.drawLine({
    start: { x: MARGIN_L, y: cursor.y + 2 },
    end: { x: COL_RIGHT, y: cursor.y + 2 },
    thickness: 2,
    color: ACCENT,
  });
  cursor.y -= 10;

  if (sr.stateRefundOrOwed >= 0) {
    drawRow(page, fonts, cursor, 'STATE REFUND', fmtDollar(sr.stateRefundOrOwed), { bold: true, color: MONEY_GREEN });
  } else {
    drawRow(page, fonts, cursor, 'STATE AMOUNT OWED', fmtDollar(Math.abs(sr.stateRefundOrOwed)), { bold: true, color: MONEY_RED });
  }

  // ─── Summary ─────────────────────────
  cursor.y -= 5;
  drawRow(page, fonts, cursor, 'Effective state rate', `${(sr.effectiveStateRate * 100).toFixed(2)}%`);

  // ─── Bracket Details ─────────────────
  if (sr.bracketDetails && sr.bracketDetails.length > 0) {
    drawSectionHeader(page, fonts, cursor, 'Tax Bracket Details');
    for (const b of sr.bracketDetails) {
      drawRow(page, fonts, cursor, `${(b.rate * 100).toFixed(1)}% bracket`, `${fmtDollar(b.taxableAtRate)} -> ${fmtDollar(b.taxAtRate)}`);
    }
  }

  // ─── Disclaimer ──────────────────────
  cursor.y -= 20;
  drawLine(page, cursor);
  cursor.y -= 12;
  page.drawText(
    'This document is for informational purposes only. State returns must be filed separately.',
    { x: MARGIN_L, y: cursor.y, size: 7, font: italic, color: LIGHT_GRAY },
  );

  return doc.save();
}
