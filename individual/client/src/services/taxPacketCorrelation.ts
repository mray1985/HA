import type { IncomeK1, TaxReturn } from '@hatax/engine';

export interface PacketBlock { documentId: string; fileName: string; page: number; text: string; x: number; y: number; width: number; height: number; ocr?: boolean; }
export interface PacketSource { documentId: string; fileName: string; page: number; text: string; x: number; y: number; width: number; height: number; ocr: boolean; cells?: { text: string; x: number; y: number; width: number; height: number }[]; }
export type PacketField = 'ordinaryBusinessIncome' | 'rentalIncome' | 'guaranteedPayments' | 'interestIncome' | 'ordinaryDividends' | 'qualifiedDividends' | 'royalties' | 'shortTermCapitalGain' | 'longTermCapitalGain' | 'netSection1231Gain' | 'section199AQBI' | 'selfEmploymentIncome' | 'section179Deduction' | 'qbiW2Wages' | 'qbiUBIA' | 'foreignTaxPaid' | 'foreignSourceIncome';
export interface PacketCandidate { id: string; field: PacketField; label: string; value: number | null; entityEin?: string; taxYear?: number; recipientTin?: string; formNumber?: string; form: 'K-1' | 'K-3' | 'Statement'; code?: string; section?: string; activity?: string; categories: string[]; country?: string; sources: PacketSource[]; issues: string[]; supported: boolean; }
export interface PacketPage { documentId: string; fileName: string; page: number; kind: 'K-1' | 'K-3' | 'Statement' | 'Other'; entityEin?: string; taxYear?: number; recipientTin?: string; formNumber?: string; sections: string[]; categories: string[]; country?: string; ocr: boolean; lines: PacketSource[]; }
export interface TaxPacketReport { id: string; pages: PacketPage[]; candidates: PacketCandidate[]; warnings: string[]; }
export const PACKET_FIELD_LABELS: Record<PacketField, string> = {
  ordinaryBusinessIncome: 'Ordinary business income (loss)', rentalIncome: 'Net rental real estate income (loss)', guaranteedPayments: 'Guaranteed payments', interestIncome: 'Interest income', ordinaryDividends: 'Ordinary dividends', qualifiedDividends: 'Qualified dividends', royalties: 'Royalties', shortTermCapitalGain: 'Net short-term capital gain (loss)', longTermCapitalGain: 'Net long-term capital gain (loss)', netSection1231Gain: 'Net section 1231 gain (loss)', section199AQBI: 'Section 199A qualified business income', selfEmploymentIncome: 'Net earnings from self-employment', section179Deduction: 'Section 179 deduction', qbiW2Wages: 'QBI W-2 wages', qbiUBIA: 'QBI unadjusted basis (UBIA)', foreignTaxPaid: 'Foreign taxes paid / accrued', foreignSourceIncome: 'Foreign-source income',
};
const RULES: { field: PacketField; pattern: RegExp; supported: boolean }[] = [
  { field: 'section199AQBI', pattern: /(?:section\s*199a\s+)?(?:qualified business income(?:\s*\(loss\))?|qbi(?:\s*\(loss\))?)/i, supported: true },
  { field: 'qbiW2Wages', pattern: /(?:qbi\s+)?w[–-]?2\s+wages/i, supported: false },
  { field: 'qbiUBIA', pattern: /(?:unadjusted basis(?: immediately after acquisition)?(?:\s*\(ubia\))?|ubia)(?: of qualified property)?/i, supported: false },
  { field: 'ordinaryBusinessIncome', pattern: /ordinary business income(?:\s*\(loss\))?/i, supported: true },
  { field: 'rentalIncome', pattern: /net rental real estate income(?:\s*\(loss\))?/i, supported: true },
  { field: 'guaranteedPayments', pattern: /guaranteed payments(?: for (?:services|capital))?/i, supported: true },
  { field: 'qualifiedDividends', pattern: /qualified dividends/i, supported: true },
  { field: 'ordinaryDividends', pattern: /ordinary dividends/i, supported: true },
  { field: 'interestIncome', pattern: /interest income/i, supported: true },
  { field: 'royalties', pattern: /royalties/i, supported: true },
  { field: 'shortTermCapitalGain', pattern: /(?:net\s+)?short[–-]term capital gain(?:\s*\(loss\))?/i, supported: true },
  { field: 'longTermCapitalGain', pattern: /(?:net\s+)?long[–-]term capital gain(?:\s*\(loss\))?/i, supported: true },
  { field: 'netSection1231Gain', pattern: /net section\s*1231\s+gain(?:\s*\(loss\))?/i, supported: true },
  { field: 'selfEmploymentIncome', pattern: /(?:net earnings from self[–-]employment|self[–-]employment (?:income|earnings))/i, supported: true },
  { field: 'section179Deduction', pattern: /section\s*179\s+(?:expense\s+)?deduction/i, supported: true },
  { field: 'foreignTaxPaid', pattern: /foreign (?:income )?taxes? (?:paid(?:\s*(?:or|\/)\s*accrued)?|accrued)/i, supported: false },
  { field: 'foreignSourceIncome', pattern: /foreign[–-]?\s*source (?:gross )?income/i, supported: false },
];
const normalizeTin = (s?: string) => s?.replace(/\D/g, '');
export function parsePacketAmount(text: string): number | null {
  const cleaned = text.trim().replace(/\$/g, '').replace(/,/g, '').replace(/\s/g, '');
  if (!/^(?:-?\d+(?:\.\d{1,2})?|\(\d+(?:\.\d{1,2})?\))$/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/[()]/g, '')) * (cleaned.startsWith('(') ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

// Read whole monetary cells, rather than finding number fragments inside an
// invalid value. Unbalanced parentheses or extra decimal digits need review.
function parseAmountCells(text: string): number[] {
  const token = /(?:\(\s*\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*\)|(?:-\s*\$?|\$\s*-?)?\s*\d[\d,]*(?:\.\d{1,2})?)/y;
  const amounts: number[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
    if (offset === text.length) break;
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match || (token.lastIndex < text.length && !/\s/.test(text[token.lastIndex]))) return [];
    const value = parsePacketAmount(match[0]);
    if (value === null) return [];
    amounts.push(value);
    offset = token.lastIndex;
  }
  return amounts;
}

function makeLines(blocks: PacketBlock[]): PacketSource[] {
  const lines: PacketBlock[][] = [];
  for (const b of [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l[0].y - b.y) <= 4);
    if (line) line.push(b); else lines.push([b]);
  }
  return lines.map(parts => {
    parts.sort((a, b) => a.x - b.x);
    const x = Math.min(...parts.map(p => p.x)), y = Math.min(...parts.map(p => p.y));
    return { documentId: parts[0].documentId, fileName: parts[0].fileName, page: parts[0].page, text: parts.map(p => p.text).join(' ').trim(), x, y, width: Math.max(...parts.map(p => p.x + p.width)) - x, height: Math.max(...parts.map(p => p.y + p.height)) - y, ocr: parts.some(p => p.ocr), cells: parts.map(p => ({ text: p.text, x: p.x, y: p.y, width: p.width, height: p.height })) };
  }).filter(line => line.text.length > 0);
}
function unique(values: (string | undefined)[]) { return [...new Set(values.filter((v): v is string => !!v))]; }
function labelledValue(lines: PacketSource[], label: RegExp, value: RegExp): string | undefined {
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = label.exec(lines[i].text);
    if (!match) continue;
    const suffix = lines[i].text.slice(match.index + match[0].length);
    const same = value.exec(suffix)?.[0];
    if (same) found.push(same);
    else if (lines[i + 1] && lines[i + 1].y - lines[i].y < 30 && value.test(lines[i + 1].text)) found.push(value.exec(lines[i + 1].text)![0]);
  }
  const values = unique(found);
  return values.length === 1 ? values[0] : undefined;
}
const issuerLabel = /(?:(?:entity|partnership|corporation|s corporation)(?:'s)?\s+(?:ein|employer identification number)|issuer\s+ein)/i;
const recipientLabel = /(?:(?:recipient|partner|shareholder|beneficiary)(?:'s)?\s+(?:tin|ssn|identifying number|taxpayer identification number))/i;

export function correlateTaxPacket(blocks: PacketBlock[], id = 'packet'): TaxPacketReport {
  const grouped = new Map<string, PacketBlock[]>();
  for (const block of blocks) { const key = `${block.documentId}:${block.page}`; grouped.set(key, [...(grouped.get(key) ?? []), block]); }
  const pages: PacketPage[] = [...grouped.values()].map(pageBlocks => {
    const lines = makeLines(pageBlocks), text = lines.map(l => l.text).join('\n');
    const title = lines.filter(l => l.y < (lines[0]?.y ?? 0) + 160).map(l => l.text.match(/^\s*schedule\s+k[–-]?([13])\b/i)?.[1]).find(Boolean);
    const kind = title === '3' ? 'K-3' : title === '1' ? 'K-1' : /statement|supplement|section\s*199a|box\s*\d+\s*code/i.test(text) ? 'Statement' : 'Other';
    const formNumbers = unique([...text.matchAll(/\bForm\s+(1065|1120[- ]?S|1041)\b/gi)].map(m => m[1].toUpperCase().replace("1120S", "1120-S").replace("1120 S", "1120-S"))); const formNumber = formNumbers.length === 1 ? formNumbers[0] : undefined;
    const year = labelledValue(lines, /(?:tax|calendar)\s+year(?:\s+(?:ending|ended))?\s*[:=]?/i, /\b20\d{2}\b/) || (/schedule\s+k[–-]?[13]/i.test(text.slice(0, 500)) ? text.slice(0, 500).match(/\b20\d{2}\b/)?.[0] : undefined);
    return { documentId: pageBlocks[0].documentId, fileName: pageBlocks[0].fileName, page: pageBlocks[0].page, kind, formNumber, entityEin: labelledValue(lines, issuerLabel, /\b\d{2}-\d{7}\b/), recipientTin: labelledValue(lines, recipientLabel, /\b(?:\d{3}-\d{2}-\d{4}|\d{2}-\d{7})\b/), taxYear: year ? Number(year) : undefined, sections: unique(lines.map(l => l.text.match(/\bpart\s+[IVX]+(?:\s*[—–-]\s*[^\d]+)?(?:.*?section\s+\d+)?/i)?.[0])), categories: unique(lines.flatMap(l => l.text.match(/(?:passive|general|foreign branch|section\s*951a|treaty resourced)\s+category/gi) || [])), country: labelledValue(lines, /country(?:\s+code)?\s*[:=]/i, /[A-Z]{2}\b/), ocr: pageBlocks.some(b => b.ocr), lines };
  });
  const allEntities = unique(pages.map(p => p.entityEin)), allYears = unique(pages.map(p => p.taxYear?.toString())), allRecipients = unique(pages.map(p => p.recipientTin));
  const allFormNumbers = unique(pages.map(p => p.formNumber));
  const candidates: PacketCandidate[] = [];
  for (const page of pages) {
    // Inherit identity only when the entire uploaded group names one entity/year.
    const entityEin = page.entityEin || (allEntities.length === 1 ? allEntities[0] : undefined);
    const taxYear = page.taxYear ?? (allYears.length === 1 ? Number(allYears[0]) : undefined);
    const formNumber = page.formNumber || (allFormNumbers.length === 1 ? allFormNumbers[0] : undefined);
    const qbiStatement = page.kind === "Statement" && /section\s*199a|\bQBI\b|qualified business income/i.test(page.lines.map(l => l.text).join(" "));
    const recipientTin = page.recipientTin || (allRecipients.length === 1 ? allRecipients[0] : undefined);
    let section = page.sections[0], code: string | undefined, activity: string | undefined;
    for (const line of page.lines) {
      if (/^part\s+[IVX]+\b/i.test(line.text)) section = line.text;
      const activityMatch = line.text.match(/^(?:trade or business|business|activity)(?:\s+(?:name|number))?\s*[:=]\s*(.+)$/i); if (activityMatch) activity = activityMatch[1].trim();
      const codeMatch = line.text.match(/\bbox\s*(\d+[a-z]?)\s*[,;:—–-]?\s*code\s*([a-z]{1,2})\b/i);
      if (codeMatch) code = `Box ${codeMatch[1]}, code ${codeMatch[2].toUpperCase()}`;
      const rule = RULES.find(r => r.pattern.test(line.text));
      if (!rule) continue;
      const label = rule.pattern.exec(line.text)!;
      // An ASCII minus belongs to the amount, even when no colon separates
      // the label and value. Removing it would turn a reported loss into income.
      const suffix = line.text.slice(label.index + label[0].length).replace(/^\s*[:=—–]\s*/, '');
      // Multiple monetary cells are preserved as ambiguous; never sum or pick a column.
      const amountTail = suffix.replace(/\*+$/, '').trim();
      const amounts = parseAmountCells(amountTail);
      const value = amounts.length === 1 ? amounts[0] : null;
      const qbiComponent = qbiStatement && rule.field === "ordinaryBusinessIncome";
      const foreign = page.kind === 'K-3' || /foreign|category|country/i.test(line.text) || page.categories.length > 0;
      const issues = [!entityEin ? 'Entity EIN needs review.' : '', !taxYear ? 'Tax year needs review.' : '', !recipientTin ? 'Recipient identity needs review.' : '', line.ocr ? 'Read by OCR; verify the original.' : '', value === null ? (amounts.length > 1 ? 'Several numeric cells; choose the correct row and column in the original.' : 'No unambiguous amount follows this label.') : '', foreign ? 'Foreign source/category/country detail needs a separate tax calculation review.' : '', page.kind === 'Other' ? 'This page is not identified as a K-1, K-3, or statement.' : '', qbiComponent ? 'QBI activity detail is not a second ordinary business income amount.' : '', !rule.supported ? 'Correlated for review; automatic calculation routing is not implemented for this item.' : ''].filter(Boolean);
      candidates.push({ id: `${id}:${page.documentId}:${page.page}:${Math.round(line.y)}:${rule.field}`, field: rule.field, label: PACKET_FIELD_LABELS[rule.field], value, entityEin, taxYear, recipientTin, formNumber, form: page.kind === 'K-1' || page.kind === 'K-3' ? page.kind : 'Statement', code, section, activity, categories: page.categories, country: page.country, sources: [line], issues, supported: rule.supported && !qbiComponent && !foreign && page.kind !== 'Other' });
    }
  }
  // Repeated base/statement totals are one value with multiple source locations.
  const deduped: PacketCandidate[] = [];
  for (const item of candidates) {
    const same = item.value === null ? undefined : deduped.find(d => d.field === item.field && d.value === item.value && d.entityEin === item.entityEin && d.taxYear === item.taxYear && d.recipientTin === item.recipientTin && d.supported === item.supported && d.code === item.code && d.section === item.section && d.formNumber === item.formNumber && d.activity === item.activity);
    if (same) { same.sources.push(...item.sources); same.issues = unique([...same.issues, ...item.issues, "Amount appears in several places; verify repeated total versus separate activity."]); } else deduped.push(item);
  }
  for (const item of deduped) if (item.supported && deduped.some(other => other !== item && other.supported && other.field === item.field && other.entityEin === item.entityEin && other.taxYear === item.taxYear && other.recipientTin === item.recipientTin && (other.value !== item.value || other.activity !== item.activity))) item.issues.push('Conflicting or separate activity amounts exist for this field. Review; do not combine automatically.');
  return { id, pages, candidates: deduped, warnings: [allEntities.length > 1 ? 'Several entities are present. Pages without explicit identity cannot be assigned automatically.' : '', allYears.length > 1 ? 'Several tax years are present. Review each item separately.' : '', pages.some(p => p.kind === 'K-3') ? 'K-3 rows and columns remain separate. This reader does not establish complete K-3 or Form 1116 calculation coverage.' : '', ...pages.filter(p => p.lines.length === 0).map(p => `No text read from ${p.fileName}, page ${p.page}.`)].filter(Boolean) };
}

export function applyReviewedPacket(tr: TaxReturn, target: IncomeK1, report: TaxPacketReport, selectedIds: string[], confirmed: boolean): IncomeK1 {
  if (!confirmed) throw new Error('Review and confirm the entity, recipient, year, activity, and values first.');
  const selected = report.candidates.filter(c => selectedIds.includes(c.id));
  if (!selected.length || selected.length !== new Set(selectedIds).size) throw new Error('Select valid extracted fields to apply.');
  const next = { ...target };
  const assigned = new Set<string>();
  for (const item of selected) {
    if (!item.supported || item.value === null) throw new Error('This item is for review only and cannot be applied automatically.');
    if ((item.formNumber === "1065" && target.entityType !== "partnership") || (item.formNumber === "1120-S" && target.entityType !== "s_corp") || (item.formNumber === "1041" && !["estate", "trust"].includes(target.entityType))) throw new Error("The source form type does not match the selected K-1 entity type.");
    if (item.taxYear !== undefined && item.taxYear !== tr.taxYear) throw new Error('The document tax year does not match this return.');
    if (item.entityEin && target.entityEin && normalizeTin(item.entityEin) !== normalizeTin(target.entityEin)) throw new Error('The document entity EIN does not match this K-1.');
    const recipients = [normalizeTin(tr.ssn), normalizeTin(tr.spouseSsn)].filter(Boolean);
    if (item.recipientTin && recipients.length && !recipients.includes(normalizeTin(item.recipientTin))) throw new Error('The recipient identity does not match this return.');
    if (item.issues.some(i => i.startsWith('Conflicting'))) throw new Error('Resolve conflicting or separate activity values in the interview.');
    if (assigned.has(item.field)) throw new Error('Only one reviewed value per field can be applied at a time.');
    assigned.add(item.field);
    Object.assign(next, { [item.field]: item.value });
  }
  return next;
}

