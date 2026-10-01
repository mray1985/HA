// Stress-test documents: seven synthetic 2025 households (SSN area 000 is
// never issued), each document filled on the official IRS blank the model
// gauntlet uses, with its true tool arguments recorded beside it.
//
// Usage: node make-docs.mjs  →  docs/*.pdf|png and truth.json next to this file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFCheckBox, PDFTextField, PDFName, PDFArray, StandardFonts, rgb, decodePDFRawStream } = require('pdf-lib');
const HERE = dirname(fileURLToPath(import.meta.url));
const FORMS = join(HERE, '..', 'forms');
const PDFJS = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
const DOCS = join(HERE, 'docs');
mkdirSync(DOCS, { recursive: true });

const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The W-2 blank (the 2026 form) with its printed year replaced. */
async function w2Blank(year) {
  const pdf = await PDFDocument.load(readFileSync(`${FORMS}/fw2.pdf`));
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages()) {
    const contents = page.node.get(PDFName.of('Contents'));
    if (!contents) continue;
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const spots = [];
    for (const ref of refs) {
      const text = Buffer.from(decodePDFRawStream(pdf.context.lookup(ref)).decode()).toString('latin1');
      const re = /24 0 0 24 ([\d.]+) ([\d.]+) Tm\n\(2026\)Tj/g;
      let m;
      while ((m = re.exec(text))) spots.push([Number(m[1]), Number(m[2])]);
      if (spots.length) pdf.context.assign(ref, pdf.context.flateStream(Buffer.from(text.replace(/\(2026\)Tj/g, '()Tj'), 'latin1')));
    }
    for (const [x, y] of spots) page.drawText(String(year), { x, y, size: 24, font, color: rgb(0, 0, 0) });
  }
  return pdf.save();
}

/**
 * A 1099-B, 1099-R or 1098-T blank (the 2026 editions print "20" outlined and
 * "26" in bold, in a font subset with no other digits): on the copy page, the
 * "26" is removed and the year's last two digits drawn in its place.
 */
async function yearBlank(file, pageIndex, year) {
  const bytes = readFileSync(`${FORMS}/${file}`);
  const pdfjs = await import(PDFJS);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
  const items = (await (await doc.getPage(pageIndex + 1)).getTextContent()).items
    .filter((i) => i.str === '26' && Math.abs(i.transform[3]) >= 14);
  await doc.destroy();
  if (items.length !== 1) throw new Error(`${file}: ${items.length} printed years`);
  const [, , , size, x, y] = items[0].transform;
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(pageIndex);
  const contents = page.node.get(PDFName.of('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  let removed = 0;
  for (const ref of refs) {
    const text = Buffer.from(decodePDFRawStream(pdf.context.lookup(ref)).decode()).toString('latin1');
    // The bold "26" follows the outlined "20" with only a font change between.
    const next = text.replace(/(\(20\)Tj\s*(?:EMC\s*)?(?:\/[^\n]*\s*)*?\/T1_\d+ 1 Tf\s*)\(26\)Tj/g, (_, head) => { removed++; return `${head}()Tj`; });
    if (next !== text) pdf.context.assign(ref, pdf.context.flateStream(Buffer.from(next, 'latin1')));
  }
  if (removed !== 1) throw new Error(`${file}: removed ${removed} year suffixes`);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText(String(year).slice(2), { x, y, size, font, color: rgb(0, 0, 0) });
  return pdf.save();
}

async function fill(blankBytes, pageIndex, prefix, fields) {
  const source = await PDFDocument.load(blankBytes);
  const form = source.getForm();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    const field = form.getField(prefix + name);
    if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
    else if (field instanceof PDFTextField) field.setText(String(value));
    else throw new Error(`unsupported field ${name}`);
  }
  form.updateFieldAppearances();
  form.flatten();
  const single = await PDFDocument.create();
  const [page] = await single.copyPages(source, [pageIndex]);
  single.addPage(page);
  return single.save();
}

async function renderPng(pdfBytes, dpi) {
  const pdfjs = await import(PDFJS);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), standardFontDataUrl: join(root, 'standard_fonts').split(sep).join('/') + '/', disableFontFace: true }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: dpi / 72 });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  const png = await canvas.encode('png');
  await doc.destroy();
  return png;
}

// ── Form builders: fields on the blank, and the true tool arguments ──

function w2(p) {
  const fields = {
    'BoxA_ReadOrder[0].f2_01[0]': p.ssn,
    'Col_Left[0].f2_02[0]': p.ein,
    'Col_Left[0].f2_03[0]': p.employer.join('\n'),
    'Col_Left[0].f2_04[0]': p.control,
    'Col_Left[0].FirstName_ReadOrder[0].f2_05[0]': p.first,
    'Col_Left[0].LastName_ReadOrder[0].f2_06[0]': p.last,
    'Col_Left[0].f2_08[0]': p.address.join('\n'),
    'Col_Right[0].Box1_ReadOrder[0].f2_09[0]': money(p.box1),
    'Col_Right[0].f2_10[0]': money(p.box2),
    'Col_Right[0].Box3_ReadOrder[0].f2_11[0]': money(p.box3),
    'Col_Right[0].f2_12[0]': money(p.box4),
    'Col_Right[0].Box5_ReadOrder[0].f2_13[0]': money(p.box5),
    'Col_Right[0].f2_14[0]': money(p.box6),
    'Col_Right[0].Retirement_ReadOrder[0].c2_3[0]': p.retirement === true,
    'Boxes15_ReadOrder[0].Box15_ReadOrder[0].f2_31[0]': p.state,
    'Boxes15_ReadOrder[0].f2_32[0]': p.stateId,
    'Box16_ReadOrder[0].f2_35[0]': p.box16 !== undefined ? money(p.box16) : undefined,
    'Box17_ReadOrder[0].f2_37[0]': p.box17 !== undefined ? money(p.box17) : undefined,
  };
  const codeFields = [['f2_20', 'f2_21'], ['f2_22', 'f2_23'], ['f2_24', 'f2_25'], ['f2_26', 'f2_27']];
  (p.box12 ?? []).forEach(([code, amount], i) => {
    fields[`Col_Right[0].Box12_ReadOrder[0].${codeFields[i][0]}[0]`] = code;
    fields[`Col_Right[0].Box12_ReadOrder[0].${codeFields[i][1]}[0]`] = money(amount);
  });
  const args = {
    employerName: p.employer[0], employerEin: p.ein, wages: p.box1, federalTaxWithheld: p.box2,
    socialSecurityWages: p.box3, socialSecurityTax: p.box4, medicareWages: p.box5, medicareTax: p.box6,
    ...(p.state ? { state: p.state, stateWages: p.box16, stateTaxWithheld: p.box17 } : {}),
    ...(p.box12?.length ? { box12: p.box12.map(([code, amount]) => ({ code, amount })) } : {}),
    box13: { statutoryEmployee: false, retirementPlan: p.retirement === true, thirdPartySickPay: false },
  };
  return { form: 'W-2', blank: 'w2', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].CopyB_Top[0].', fields, tool: 'add_w2', args };
}

const recipient = (p, f) => ({ [f.tin]: `XXX-XX-${p.ssn.slice(-4)}`, [f.name]: `${p.first} ${p.last}` });

function int1099(p) {
  return {
    form: '1099-INT', blank: 'f1099int.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyBHeader[0].CalendarYear2_1[0]': '25',
      'LeftColumn[0].f2_1[0]': p.payer.join('\n'),
      'LeftColumn[0].f2_2[0]': p.ein,
      ...recipient(p, { tin: 'LeftColumn[0].f2_3[0]', name: 'LeftColumn[0].f2_4[0]' }),
      'LeftColumn[0].f2_5[0]': p.address[0],
      'LeftColumn[0].f2_6[0]': p.address[1],
      'RghtColumn[0].Box1[0].f2_9[0]': money(p.box1),
      'RghtColumn[0].Box4[0].f2_12[0]': p.box4 ? money(p.box4) : undefined,
    },
    tool: 'add_1099_int',
    args: { payerName: p.payer[0], amount: p.box1, ...(p.box4 ? { federalTaxWithheld: p.box4 } : {}) },
  };
}

function div1099(p) {
  return {
    form: '1099-DIV', blank: 'f1099div.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftCol[0].f2_2[0]': p.payer.join('\n'),
      'LeftCol[0].f2_3[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_4[0]', name: 'LeftCol[0].f2_5[0]' }),
      'LeftCol[0].f2_6[0]': p.address[0],
      'LeftCol[0].f2_7[0]': p.address[1],
      'RghtCol[0].f2_9[0]': money(p.box1a),
      'RghtCol[0].f2_10[0]': money(p.box1b),
      'RghtCol[0].Box2a_ReadOrder[0].f2_11[0]': p.box2a ? money(p.box2a) : undefined,
    },
    tool: 'add_1099_div',
    args: { payerName: p.payer[0], ordinaryDividends: p.box1a, qualifiedDividends: p.box1b, ...(p.box2a ? { capitalGainDistributions: p.box2a } : {}) },
  };
}

function mortgage1098(p) {
  return {
    form: '1098', blank: 'f1098.pdf', pageIndex: 2, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftCol[0].f2_2[0]': p.lender.join('\n'),
      'LeftCol[0].f2_3[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_4[0]', name: 'LeftCol[0].f2_5[0]' }),
      'LeftCol[0].f2_6[0]': p.address[0],
      'LeftCol[0].f2_7[0]': p.address[1],
      'LeftCol[0].f2_10[0]': p.account,
      'RightCol[0].f2_11[0]': money(p.box1),
      'RightCol[0].f2_12[0]': money(p.box2),
      'RightCol[0].f2_13[0]': p.box3,
      'RightCol[0].c2_3[0]': true,
      'RightCol[0].TagCorrectingSubform[0].f2_8[0]': '1',
    },
    tool: 'add_mortgage_interest',
    args: { lenderName: p.lender[0], lenderTin: p.ein, mortgageInterest: p.box1, outstandingPrincipal: p.box2, originationDate: p.box3, propertyAddressSameAsBorrower: true, numberOfProperties: 1 },
  };
}

function g1099(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1099-G', blank: 'f1099g.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftColumn[0].f2_2[0]': p.payer[0], 'LeftColumn[0].f2_3[0]': p.payer[1], 'LeftColumn[0].f2_5[0]': p.payer[2], 'LeftColumn[0].f2_6[0]': p.payer[3], 'LeftColumn[0].f2_8[0]': p.payer[4],
      'LeftColumn[0].f2_10[0]': p.ein,
      ...recipient(p, { tin: 'LeftColumn[0].f2_11[0]', name: 'LeftColumn[0].f2_12[0]' }),
      'LeftColumn[0].f2_13[0]': street, 'LeftColumn[0].f2_15[0]': city, 'LeftColumn[0].f2_16[0]': st, 'LeftColumn[0].f2_18[0]': zip,
      'RightColumn[0].f2_20[0]': money(p.box1),
      'RightColumn[0].f2_23[0]': p.box4 ? money(p.box4) : undefined,
    },
    tool: 'add_1099_g',
    args: { payerName: p.payer[0], unemploymentCompensation: p.box1, ...(p.box4 ? { federalTaxWithheld: p.box4 } : {}) },
  };
}

function t1098(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1098-T', blank: 'f1098t.pdf', pageIndex: 2, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'LeftCol[0].f2_1[0]': p.school[0], 'LeftCol[0].f2_2[0]': p.school[1], 'LeftCol[0].f2_4[0]': p.school[2], 'LeftCol[0].f2_5[0]': p.school[3], 'LeftCol[0].f2_7[0]': p.school[4],
      'LeftCol[0].f2_9[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_10[0]', name: 'LeftCol[0].f2_11[0]' }),
      'LeftCol[0].f2_12[0]': street, 'LeftCol[0].f2_14[0]': city, 'LeftCol[0].f2_15[0]': st, 'LeftCol[0].f2_17[0]': zip,
      'LeftCol[0].f2_18[0]': p.studentId,
      'RightCol[0].f2_19[0]': money(p.box1),
      'RightCol[0].f2_21[0]': p.box5 ? money(p.box5) : undefined,
      'RightCol[0].c2_4[0]': true,
    },
    tool: 'add_education_expense',
    args: { institutionName: p.school[0], institutionEin: p.ein, studentName: `${p.first} ${p.last}`, tuitionPaid: p.box1, scholarships: p.box5 ?? 0, includesNextPeriod: false, halfTimeStudent: true, graduateStudent: false },
  };
}

function r1099(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1099-R', blank: 'f1099r.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'LeftCol[0].f2_1[0]': p.payer[0], 'LeftCol[0].f2_2[0]': p.payer[1], 'LeftCol[0].f2_4[0]': p.payer[2], 'LeftCol[0].f2_6[0]': p.payer[3], 'LeftCol[0].f2_8[0]': p.payer[4],
      'LeftCol[0].PayersTIN[0].f2_9[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_10[0]', name: 'LeftCol[0].f2_11[0]' }),
      'LeftCol[0].f2_12[0]': street, 'LeftCol[0].f2_14[0]': city, 'LeftCol[0].f2_15[0]': st, 'LeftCol[0].f2_17[0]': zip,
      'RightCol[0].f2_19[0]': money(p.box1),
      'RightCol[0].f2_20[0]': money(p.box2a),
      'RightCol[0].f2_22[0]': money(p.box4),
      'RightCol[0].f2_25[0]': p.code,
      'RightCol[0].Box7b_ReadOrder[0].c2_4[0]': p.ira === true,
    },
    tool: 'add_1099_r',
    args: { payerName: p.payer[0], grossDistribution: p.box1, taxableAmount: p.box2a, federalTaxWithheld: p.box4, distributionCode: p.code, isIRA: p.ira === true },
  };
}

function nec1099(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1099-NEC', blank: 'f1099nec.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'PgHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftCol[0].f2_2[0]': p.payer[0], 'LeftCol[0].f2_3[0]': p.payer[1], 'LeftCol[0].f2_5[0]': p.payer[2], 'LeftCol[0].f2_7[0]': p.payer[3], 'LeftCol[0].f2_9[0]': p.payer[4],
      'LeftCol[0].f2_10[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_11[0]', name: 'LeftCol[0].f2_12[0]' }),
      'LeftCol[0].f2_13[0]': street, 'LeftCol[0].f2_15[0]': city, 'LeftCol[0].f2_16[0]': st, 'LeftCol[0].f2_18[0]': zip,
      'RightCol[0].f2_20[0]': money(p.box1),
    },
    tool: 'add_1099_nec',
    args: { payerName: p.payer[0], payerEin: p.ein, amount: p.box1 },
  };
}

function misc1099(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1099-MISC', blank: 'f1099msc.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftColumn[0].f2_2[0]': p.payer[0], 'LeftColumn[0].f2_3[0]': p.payer[1], 'LeftColumn[0].f2_5[0]': p.payer[2], 'LeftColumn[0].f2_7[0]': p.payer[3], 'LeftColumn[0].f2_9[0]': p.payer[4],
      'LeftColumn[0].f2_10[0]': p.ein,
      ...recipient(p, { tin: 'LeftColumn[0].f2_11[0]', name: 'LeftColumn[0].f2_12[0]' }),
      'LeftColumn[0].f2_13[0]': street, 'LeftColumn[0].f2_15[0]': city, 'LeftColumn[0].f2_16[0]': st, 'LeftColumn[0].f2_18[0]': zip,
      'RightColumn[0].Box3_ReadOrder[0].f2_22[0]': money(p.box3),
    },
    tool: 'add_1099_misc',
    args: { payerName: p.payer[0], otherIncome: p.box3 },
  };
}

function b1099(p) {
  const [street, cityLine] = p.address;
  const [, city, st, zip] = cityLine.match(/^(.*) ([A-Z]{2}) (\d{5})$/);
  return {
    form: '1099-B', blank: 'f1099b.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'LeftCol[0].f2_1[0]': p.payer[0], 'LeftCol[0].f2_2[0]': p.payer[1], 'LeftCol[0].f2_4[0]': p.payer[2], 'LeftCol[0].f2_5[0]': p.payer[5], 'LeftCol[0].f2_6[0]': p.payer[3], 'LeftCol[0].f2_8[0]': p.payer[4],
      'LeftCol[0].f2_9[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_10[0]', name: 'LeftCol[0].f2_11[0]' }),
      'LeftCol[0].f2_12[0]': street, 'LeftCol[0].f2_14[0]': city, 'LeftCol[0].f2_15[0]': st, 'LeftCol[0].f2_17[0]': zip,
      'RightCol[0].f2_21[0]': p.description,
      'RightCol[0].f2_22[0]': p.acquired,
      'RightCol[0].f2_23[0]': p.sold,
      'RightCol[0].Box1d[0].f2_24[0]': money(p.proceeds),
      'RightCol[0].f2_25[0]': money(p.basis),
      'RightCol[0].Box2[0].c2_4[1]': true,
      'RightCol[0].Box6[0].c2_7[0]': true,
      'RightCol[0].Box12[0].c2_9[0]': true,
    },
    tool: 'add_1099_b',
    args: { brokerName: p.payer[0], description: p.description, dateAcquired: p.acquired, dateSold: p.sold, proceeds: p.proceeds, costBasis: p.basis, isLongTerm: true, basisReportedToIRS: true },
  };
}

function oid1099(p) {
  return {
    form: '1099-OID', blank: 'f1099oid.pdf', pageIndex: 3, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'CopyHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftCol[0].f2_2[0]': p.payer.join('\n'),
      'LeftCol[0].f2_3[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_4[0]', name: 'LeftCol[0].f2_5[0]' }),
      'LeftCol[0].f2_6[0]': p.address[0],
      'LeftCol[0].f2_7[0]': p.address[1],
      'RightCol[0].f2_9[0]': money(p.box1),
      'RightCol[0].f2_15[0]': p.description,
    },
    tool: 'add_1099_oid',
    args: { payerName: p.payer[0], originalIssueDiscount: p.box1, description: p.description },
  };
}

function c1099(p) {
  return {
    form: '1099-C', blank: 'f1099c.pdf', pageIndex: 2, prefix: 'topmostSubform[0].CopyB[0].',
    fields: {
      'FormHeader[0].CalendarYear[0].f2_1[0]': '2025',
      'LeftCol[0].f2_2[0]': p.payer.join('\n'),
      'LeftCol[0].f2_3[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f2_4[0]', name: 'LeftCol[0].f2_5[0]' }),
      'LeftCol[0].f2_6[0]': p.address[0],
      'LeftCol[0].f2_7[0]': p.address[1],
      'RightCol[0].f2_9[0]': p.date,
      'RightCol[0].f2_10[0]': money(p.box2),
      'RightCol[0].f2_12[0]': p.description,
      'RightCol[0].c2_2[0]': true,
      'RightCol[0].f2_13[0]': p.code,
    },
    tool: 'add_1099_c',
    args: { payerName: p.payer[0], dateOfCancellation: p.date, amountCancelled: p.box2, debtDescription: p.description, identifiableEventCode: p.code, personallyLiable: true },
  };
}

function sa1099(p) {
  return {
    form: '1099-SA', blank: 'f1099sa.pdf', pageIndex: 1, prefix: 'Form1099-SA[0].CopyB[0].',
    fields: {
      'CopyBHeader[0].f1_1[0]': '2025',
      'LeftCol[0].f1_2[0]': p.payer.join('\n'),
      'LeftCol[0].f1_3[0]': p.ein,
      ...recipient(p, { tin: 'LeftCol[0].f1_4[0]', name: 'LeftCol[0].f1_5[0]' }),
      'LeftCol[0].f1_6[0]': p.address[0],
      'LeftCol[0].f1_7[0]': p.address[1],
      'RightCol[0].f1_9[0]': money(p.box1),
      'RightCol[0].f1_11[0]': p.code,
      'RightCol[0].c1_2[0]': true,
    },
    tool: 'add_1099_sa',
    args: { payerName: p.payer[0], grossDistribution: p.box1, distributionCode: p.code, accountType: 'HSA' },
  };
}

// ── The households ──

const ava = { first: 'AVA', last: 'LINDQVIST', ssn: '000-21-4401', address: ['2150 J ST APT 4', 'SACRAMENTO CA 95816'] };
const ben = { first: 'BEN', last: 'OKAFOR', ssn: '000-31-5501', address: ['1427 ASPEN CT', 'NAPERVILLE IL 60540'] };
const cara = { first: 'CARA', last: 'OKAFOR', ssn: '000-31-5502', address: ben.address };
const dana = { first: 'DANA', last: 'WHITFIELD', ssn: '000-41-6601', address: ['318 MAPLE ST', 'PITTSBURGH PA 15213'] };
const eli = { first: 'ELI', last: 'BRANDT', ssn: '000-51-7701', address: ['4410 BAYSHORE BLVD', 'TAMPA FL 33611'] };
const fay = { first: 'FAY', last: 'MORENO', ssn: '000-61-8801', address: ['77 RAINEY ST UNIT 9', 'AUSTIN TX 78701'] };
const gus = { first: 'GUS', last: 'PETROV', ssn: '000-71-9901', address: ['52 LARK ST', 'ALBANY NY 12210'] };
const hana = { first: 'HANA', last: 'SATO', ssn: '000-81-1101', address: ['960 N HIGH ST APT 12', 'COLUMBUS OH 43201'] };

const avaW2 = { ...ava, ein: '94-3216540', employer: ['CAPITOL CITY ANALYTICS INC', '980 9TH ST', 'SACRAMENTO CA 95814'], control: '10021',
  box1: 68250, box2: 7120, box3: 71000, box4: 4402, box5: 71000, box6: 1029.5, box12: [['D', 2750], ['DD', 6400]], retirement: true,
  state: 'CA', stateId: '123-4567-8', box16: 68250, box17: 3050 };

const DOCS_SPEC = [
  // Ava: single, California. Her W-2 also comes as a phone photo, and last year's W-2 is in the pile.
  { file: 'ava-w2.pdf', household: 'Ava Lindqvist', person: 'taxpayer', ...w2(avaW2), year: 2025 },
  { file: 'ava-w2-photo.png', household: 'Ava Lindqvist', person: 'taxpayer', ...w2(avaW2), year: 2025, png: 150, expect: 'the same W-2 as ava-w2.pdf: must not count twice' },
  { file: 'ava-w2-2024.pdf', household: 'Ava Lindqvist', person: 'taxpayer', ...w2({ ...avaW2, control: '09877', box1: 64100, box2: 6640, box3: 66600, box4: 4129.2, box5: 66600, box6: 965.7, box12: [['D', 2500]], box16: 64100, box17: 2810 }), year: 2024, expect: 'a 2024 W-2: warned, not on the 2025 return' },
  { file: 'ava-1099int.pdf', household: 'Ava Lindqvist', person: 'taxpayer', ...int1099({ ...ava, payer: ['GOLDEN STATE CREDIT UNION', '1 CAPITOL MALL', 'SACRAMENTO CA 95814'], ein: '94-1112233', box1: 412.38 }) },

  // Ben and Cara: married filing jointly, Illinois, two children.
  { file: 'ben-w2.pdf', household: 'Ben Okafor', person: 'taxpayer', ...w2({ ...ben, ein: '36-4455661', employer: ['PRAIRIE RAIL SYSTEMS LLC', '200 W ADAMS ST', 'CHICAGO IL 60606'], control: '55102',
    box1: 84300, box2: 9850, box3: 84300, box4: 5226.6, box5: 84300, box6: 1222.35, state: 'IL', stateId: '4455-6610', box16: 84300, box17: 4172.85 }), year: 2025 },
  { file: 'cara-w2.pdf', household: 'Ben Okafor', person: 'spouse', ...w2({ ...cara, ein: '36-7788990', employer: ['LAKESIDE PEDIATRIC CLINIC', '55 SHUMAN BLVD', 'NAPERVILLE IL 60563'], control: '00318',
    box1: 47900, box2: 3960, box3: 50900, box4: 3155.8, box5: 50900, box6: 738.05, box12: [['E', 3000]], retirement: true, state: 'IL', stateId: '7788-9901', box16: 47900, box17: 2371.05 }), year: 2025 },
  { file: 'okafor-1099div.pdf', household: 'Ben Okafor', person: 'taxpayer', ...div1099({ ...ben, payer: ['LAKEFRONT INDEX FUNDS', 'PO BOX 1200', 'CHICAGO IL 60690'], ein: '36-1200345', box1a: 1845.2, box1b: 1610.75, box2a: 225 }) },
  { file: 'okafor-1098.pdf', household: 'Ben Okafor', person: 'taxpayer', ...mortgage1098({ ...ben, lender: ['PRAIRIE HOME MORTGAGE CO', '10 E JEFFERSON AVE', 'NAPERVILLE IL 60540', '630-555-0110'], ein: '36-9900112', account: '7700123456', box1: 11240.66, box2: 289400, box3: '06/01/2020' }) },

  // Dana: head of household, Pennsylvania, unemployment for part of the year, her own college classes.
  { file: 'dana-w2.pdf', household: 'Dana Whitfield', person: 'taxpayer', ...w2({ ...dana, ein: '25-3344556', employer: ['ALLEGHENY GROCERS INC', '1 SMITHFIELD ST', 'PITTSBURGH PA 15222'], control: '22014',
    box1: 39750, box2: 2310, box3: 39750, box4: 2464.5, box5: 39750, box6: 576.38, state: 'PA', stateId: '98765432', box16: 39750, box17: 1220.33 }), year: 2025 },
  { file: 'dana-1099g.pdf', household: 'Dana Whitfield', person: 'taxpayer', ...g1099({ ...dana, payer: ['PA DEPT OF LABOR AND INDUSTRY', '651 BOAS ST', 'HARRISBURG', 'PA', '17121'], ein: '23-6003113', box1: 3600, box4: 360 }) },
  { file: 'dana-1098t.pdf', household: 'Dana Whitfield', person: 'taxpayer', ...t1098({ ...dana, school: ['STEEL CITY COMMUNITY COLLEGE', '808 RIDGE AVE', 'PITTSBURGH', 'PA', '15212'], ein: '25-1010101', studentId: 'SC4471902', box1: 4200 }) },

  // Eli: single retiree, 68, Florida.
  { file: 'eli-1099r.pdf', household: 'Eli Brandt', person: 'taxpayer', ...r1099({ ...eli, payer: ['GULF COAST RETIREMENT SERVICES', '100 N TAMPA ST', 'TAMPA', 'FL', '33602'], ein: '59-2233445', box1: 24000, box2a: 24000, box4: 2400, code: '7', ira: true }) },
  { file: 'eli-1099int.pdf', household: 'Eli Brandt', person: 'taxpayer', ...int1099({ ...eli, payer: ['SUNSHINE SAVINGS BANK', '400 N ASHLEY DR', 'TAMPA FL 33602'], ein: '59-8877665', box1: 2310.4 }) },
  { file: 'eli-1099div.pdf', household: 'Eli Brandt', person: 'taxpayer', ...div1099({ ...eli, payer: ['PELICAN DIVIDEND FUND', 'PO BOX 4455', 'ST PETERSBURG FL 33731'], ein: '59-4455667', box1a: 3120, box1b: 2880, box2a: 640 }) },

  // Fay: single freelancer, Texas, two clients and an award.
  { file: 'fay-1099nec-brewing.pdf', household: 'Fay Moreno', person: 'taxpayer', ...nec1099({ ...fay, payer: ['HILL COUNTRY BREWING CO', '1200 E 6TH ST', 'AUSTIN', 'TX', '78702'], ein: '74-3322110', box1: 28400 }) },
  { file: 'fay-1099nec-events.pdf', household: 'Fay Moreno', person: 'taxpayer', ...nec1099({ ...fay, payer: ['LONGHORN EVENTS LLC', '500 E CESAR CHAVEZ ST', 'AUSTIN', 'TX', '78701'], ein: '74-5566778', box1: 12750 }) },
  { file: 'fay-1099misc.pdf', household: 'Fay Moreno', person: 'taxpayer', ...misc1099({ ...fay, payer: ['AUSTIN DESIGN AWARDS FOUNDATION', '901 W RIVERSIDE DR', 'AUSTIN', 'TX', '78704'], ein: '74-9988776', box3: 1200 }) },

  // Gus: single, New York, W-2 and investments.
  { file: 'gus-w2.pdf', household: 'Gus Petrov', person: 'taxpayer', ...w2({ ...gus, ein: '14-6677889', employer: ['HUDSON VALLEY SOFTWARE CORP', '400 BROADWAY', 'ALBANY NY 12207'], control: '71200',
    box1: 112000, box2: 17400, box3: 112000, box4: 6944, box5: 112000, box6: 1624, state: 'NY', stateId: '14-6677889', box16: 112000, box17: 6050 }), year: 2025 },
  { file: 'gus-1099b.pdf', household: 'Gus Petrov', person: 'taxpayer', ...b1099({ ...gus, payer: ['EMPIRE BROKERAGE LLC', '1 STATE ST', 'NEW YORK', 'NY', '10004', '212-555-0190'], ein: '13-4455667', description: '60 sh. BETA INDUSTRIES', acquired: '06/14/2020', sold: '08/22/2025', proceeds: 18250, basis: 11400 }) },
  { file: 'gus-1099oid.pdf', household: 'Gus Petrov', person: 'taxpayer', ...oid1099({ ...gus, payer: ['CAPITAL DISTRICT SECURITIES', '80 STATE ST', 'ALBANY NY 12207', '518-555-0133'], ein: '13-2233445', box1: 210.55, description: 'ZERO COUPON NOTE 2030' }) },

  // Hana: single, Ohio; her W-2 is a scan (no text layer), a cancelled card debt and an HSA distribution.
  { file: 'hana-w2-scan.png', household: 'Hana Sato', person: 'taxpayer', ...w2({ ...hana, ein: '31-5566778', employer: ['BUCKEYE MEDICAL SUPPLY INC', '100 E BROAD ST', 'COLUMBUS OH 43215'], control: '31007',
    box1: 51200, box2: 4980, box3: 51200, box4: 3174.4, box5: 51200, box6: 742.4, box12: [['W', 1200]], state: 'OH', stateId: '31-5566778', box16: 51200, box17: 1150 }), year: 2025, png: 200 },
  { file: 'hana-1099c.pdf', household: 'Hana Sato', person: 'taxpayer', ...c1099({ ...hana, payer: ['OHIO VALLEY CARD SERVICES', '250 W ST CLAIR AVE', 'CLEVELAND OH 44113', '216-555-0166'], ein: '31-9988770', date: '09/30/2025', box2: 2150, description: 'CREDIT CARD', code: 'G' }) },
  { file: 'hana-1099sa.pdf', household: 'Hana Sato', person: 'taxpayer', ...sa1099({ ...hana, payer: ['BUCKEYE HSA BANK', '41 S HIGH ST', 'COLUMBUS OH 43215', '614-555-0111'], ein: '31-1212121', box1: 1350, code: '1' }) },
];

const blanks = new Map();
async function blank(spec) {
  const key = spec.blank === 'w2' ? `w2-${spec.year}` : spec.blank;
  const printed = ['f1099b.pdf', 'f1099r.pdf', 'f1098t.pdf'].includes(spec.blank);
  if (!blanks.has(key)) {
    blanks.set(key, spec.blank === 'w2' ? await w2Blank(spec.year)
      : printed ? await yearBlank(spec.blank, spec.pageIndex, 2025)
      : readFileSync(`${FORMS}/${spec.blank}`));
  }
  return blanks.get(key);
}

const truth = [];
for (const spec of DOCS_SPEC) {
  const pdf = await fill(await blank(spec), spec.pageIndex, spec.prefix, spec.fields);
  writeFileSync(join(DOCS, spec.file), spec.png ? await renderPng(pdf, spec.png) : pdf);
  truth.push({ file: spec.file, household: spec.household, person: spec.person, form: spec.form, year: spec.year ?? 2025, tool: spec.tool, args: spec.args, ...(spec.expect ? { expect: spec.expect } : {}) });
  console.log(spec.file);
}

const replies = {
  'Ava Lindqvist': "Hi! I'm single with no dependents and lived in California all of 2025. The 2024 W-2 got mixed in by mistake, and the photo is the same W-2 as the PDF.",
  'Ben Okafor': 'Ben and I (Cara Okafor, SSN 000-31-5502, born July 19, 1988) are married and file jointly. Ben was born March 2, 1986. Our kids Noah Okafor (born April 12, 2016, SSN 000-55-1201) and Lily Okafor (born September 30, 2019, SSN 000-55-1202) lived with us all year. We all live in Illinois.',
  'Dana Whitfield': "I'm filing as head of household. My son Marcus Whitfield (born February 3, 2014, SSN 000-66-3001) lived with me all year and I paid all the household costs. The 1098-T is for my own classes at the community college.",
  'Eli Brandt': "I'm single, born May 20, 1957, retired and a Florida resident all year. No dependents.",
  'Fay Moreno': "I'm single with no dependents, a Texas resident. I'm a freelance designer; my business expenses were $3,200 for software and equipment.",
  'Gus Petrov': "I'm single with no dependents and lived in New York all year.",
  'Hana Sato': "I'm single, no dependents, Ohio resident. The HSA distribution paid doctor bills. The credit card debt was cancelled and I was not insolvent.",
};

writeFileSync(join(HERE, 'truth.json'), JSON.stringify({ taxYear: 2025, documents: truth, replies }, null, 2));
console.log(`${truth.length} documents → ${DOCS}`);
