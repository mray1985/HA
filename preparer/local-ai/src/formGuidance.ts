/**
 * What each document is, in words a preparer can act on.
 *
 * The reader can only place some of a form's boxes on a return by itself. This
 * says what the document is, who had to send it, what it does to the return, and
 * what a person still has to do. It exists because a filled box the reader could
 * not place used to reach nobody at all: the schema marks those boxes for review
 * and the list was then dropped.
 *
 * Deliberately plain and short. The per-box detail is not repeated here — it
 * comes from the schema, which carries each box's printed number and the form's
 * own label for it, so it cannot drift from the reader the way prose would.
 *
 * The four forms with no extraction schema (W-2G, 1098-E, 1095-A, K-1) are here
 * too, and say so honestly: they are read from the text layer, and a preparer
 * still enters them.
 */

import type { ClassifiableFormType } from './documentClassifier.js';

export interface FormGuidance {
  /** What to call it out loud. */
  name: string;
  /** One sentence: what the document is. */
  what: string;
  /** Who had to send it, and why. */
  why: string;
  /** What it does to the return. */
  applies: string;
  /**
   * What a preparer still has to do by hand. Omitted when the form is placed on
   * the return completely.
   */
  byHand?: string;
}

export const FORM_GUIDANCE: Record<ClassifiableFormType, FormGuidance> = {
  'W-2': {
    name: 'W-2 (wages)',
    what: "Your employer's record of what they paid you and the tax they took out.",
    why: 'An employer has to send this to every employee and to the IRS.',
    applies:
      'Adds the pay to Form 1040 as wages, and the amounts withheld to your total payments. Boxes 12 and 13 carry retirement and benefit codes that are already read.',
    byHand:
      'Any box listed under this document was filled in but cannot be placed on the return. Tips, dependent-care benefits and nonqualified plans need a decision. A second state line means the client worked in more than one state.',
  },
  'W-2C': {
    name: 'W-2c (corrected wages)',
    what: "An employer's corrected version of a W-2 they already sent.",
    why: 'Sent when a W-2 was wrong — a wrong amount, or the wrong person’s details.',
    applies:
      'Corrects the W-2 on this case that has the same employer ID number and year. It never creates a second W-2.',
    byHand:
      'Check the year printed in box c. A correction for a year that is not on this return will not apply.',
  },
  'W-2G': {
    name: 'W-2G (gambling winnings)',
    what: 'A report of gambling winnings and tax taken out of them.',
    why: 'A casino or betting site sends this when winnings are reportable or tax was withheld.',
    applies:
      'Would add the winnings as other income and the withholding to your payments. Losses are only deductible up to the winnings, and only if the client itemises.',
    byHand:
      'This form is read from its text layer but is not placed on the return for you. Enter box 1 as other income and box 4 as federal withholding.',
  },
  '1099-INT': {
    name: '1099-INT (interest)',
    what: 'A bank or lender reporting interest it paid you.',
    why: 'Anyone paying $600 or more of interest has to report it.',
    applies: 'Adds the interest to Form 1040 and the withholding to your payments.',
    byHand:
      'An early withdrawal penalty is reported on this form but the app places it for you — check it if the client took money out early.',
  },
  '1099-DIV': {
    name: '1099-DIV (dividends)',
    what: 'A fund or company reporting dividends and distributions it paid you.',
    why: 'Any payer of $600 or more has to report it.',
    applies:
      'Adds ordinary and qualified dividends to Form 1040 and the withholding to your payments. Qualified dividends are taxed at the lower capital-gains rate.',
    byHand:
      'Box 5 is reported but has nowhere to go on the return, so it is listed for you to look at. Box 2b and box 2d change which rate applies and are read automatically.',
  },
  '1099-NEC': {
    name: '1099-NEC (self-employment)',
    what: 'A payer reporting money it paid you for work you did as a non-employee.',
    why: 'Anyone paying $600 or more for services has to report it.',
    applies: 'Adds the amount to Form 1040 as self-employment income.',
    byHand:
      'This form is read from its text layer. Direct sales of $5,000 or more are noted on the form and change how the income is treated.',
  },
  '1099-R': {
    name: '1099-R (pension or IRA)',
    what: 'A plan reporting a distribution it paid you from a retirement account.',
    why: 'Every pension, IRA and 401(k) payout has to be reported.',
    applies:
      'Adds the distribution to Form 1040 and the withholding to your payments. The taxable part is usually less than the total if the client contributed.',
    byHand:
      'Box 5a and box 5b show deductions that were already taken out. Check whether the client took a distribution before turning 62 or before a plan ended.',
  },
  '1099-MISC': {
    name: '1099-MISC (other income)',
    what: 'A payer reporting other kinds of income — rent, royalties, prizes, fees.',
    why: 'Any payer of $600 or more has to report it.',
    applies: 'Adds rents, royalties and other income to Form 1040.',
    byHand:
      'Anything listed under this document was filled in but cannot be placed for you. Fishing proceeds, medical payments and substitute payments each need their own line.',
  },
  '1099-G': {
    name: '1099-G (unemployment)',
    what: 'A state agency reporting unemployment benefits it paid you.',
    why: 'The state pays the benefit and has to report it.',
    applies: 'Adds the benefits to Form 1040 and the withholding to your payments.',
    byHand:
      'Box 2 is a refund of state tax from an earlier year. It is listed for you because it may be taxable this year.',
  },
  '1099-B': {
    name: '1099-B (broker sale)',
    what: 'A broker reporting a sale of investments it held for you.',
    why: 'Brokers have to report every sale, profit or loss.',
    applies:
      'Adds the proceeds and the cost basis to Schedule D so the gain or loss flows to Form 1040.',
    byHand:
      'Box 2 tells you whether the sale was long or short term — the app reads the printed square, so check it. Wash sales and federal withholding are listed for you.',
  },
  '1099-K': {
    name: '1099-K (card and third-party payments)',
    what: 'A payment company reporting card and app payments you received.',
    why: 'Payment processors have to report gross amounts once they pass the threshold.',
    applies: 'Would add the gross amount to Form 1040 as self-employment income.',
    byHand:
      'This form is read from its text layer but is not placed on the return for you. Most gross amounts include tips and sales tax that are not income — check what the client actually earned.',
  },
  '1099-OID': {
    name: '1099-OID (original issue discount)',
    what: 'A holder reporting interest from a bond bought at a discount.',
    why: 'The issuer or broker has to report it.',
    applies: 'Adds the discount to Form 1040 as interest income.',
    byHand:
      'Only box 1 is placed for you. Other periodic interest, a market discount or an acquisition premium are listed and each is taxed differently.',
  },
  'SSA-1099': {
    name: 'SSA-1099 (Social Security)',
    what: 'The Social Security Administration reporting your benefit for the year.',
    why: 'Everyone receiving a benefit gets one.',
    applies:
      'Would add the taxable benefit to Form 1040. Part of the benefit may be withheld for Medicare.',
    byHand:
      'Enter box 5 as the benefit and box 6 as federal withholding. Benefits repaid to Social Security in box 4 reduce the amount that is taxable.',
  },
  '1099-SA': {
    name: '1099-SA (HSA distribution)',
    what: 'A health account reporting money it paid out of an HSA or MSA.',
    why: 'The account has to report every distribution.',
    applies:
      'Would add the distribution to Form 1040. If the client spent it on medical costs, it is not taxable.',
    byHand:
      'Box 3 says why the money was paid out. The amount is not taxable if it was for qualified medical expenses — ask the client before entering it.',
  },
  '1099-Q': {
    name: '1099-Q (education plan)',
    what: 'A 529 plan or education account reporting money it paid out.',
    why: 'The plan has to report every distribution from the account.',
    applies: 'Adds the distribution to Form 1040 as other income.',
    byHand:
      'The app cannot see how much of the money was spent on qualified education. The tax on it is waived only for the part that was, so ask the client what they spent it on.',
  },
  '1099-C': {
    name: '1099-C (debt cancelled)',
    what: 'A lender reporting debt it wrote off or cancelled.',
    why: 'Debt that is cancelled has to be reported as income.',
    applies:
      'Adds the cancelled amount to Form 1040, unless the client was insolvent or the debt was cancelled in a bankruptcy.',
    byHand:
      'Box 10 says whether the client was personally liable. That answer decides whether any of this is taxable.',
  },
  '1099-S': {
    name: '1099-S (property sold)',
    what: 'A closing agent reporting a property sale it handled.',
    why: 'Whoever closes the sale has to report it.',
    applies: 'Adds the gross proceeds to Form 1040.',
    byHand:
      'The app cannot see how long the client owned the property or what it originally cost, so it cannot work out the gain. Ask for those before filing.',
  },
  '1098': {
    name: '1098 (mortgage interest)',
    what: 'A lender reporting the interest it charged on a mortgage.',
    why: 'Anyone taking $600 or more of mortgage interest has to report it.',
    applies:
      'Adds the interest to Schedule A as a deduction. It only helps if the client itemises rather than taking the standard deduction.',
    byHand:
      'Points paid on the mortgage may also be deductible. Refunds of overpaid interest and mortgage insurance premiums are listed for you.',
  },
  '1098-T': {
    name: '1098-T (tuition)',
    what: 'A school reporting tuition and fees it charged, and any scholarships it applied.',
    why: 'Schools have to report tuition paid.',
    applies:
      'Records what was paid so an education credit can be worked out. The credit itself is not automatic.',
    byHand:
      'A scholarship the school reduced the tuition by is shown separately. The app will not claim a credit for money the client did not pay.',
  },
  '1098-E': {
    name: '1098-E (student loan interest)',
    what: 'A lender reporting student loan interest it charged.',
    why: 'Lenders have to report interest of $600 or more.',
    applies:
      'Would be an adjustment to income on Form 1040 — up to $2,500, reduced as income rises. It does not need itemising.',
    byHand:
      'This form is read from its text layer but is not placed on the return for you. Enter box 1 as student loan interest. Loans paid by someone else, or for a dependent, follow different rules.',
  },
  '1095-A': {
    name: '1095-A (Marketplace health cover)',
    what: 'The health insurance Marketplace reporting a policy and any help it paid with your premiums.',
    why: 'The Marketplace sends it if anyone in the household enrolled through it.',
    applies:
      'Feeds Form 8962, which works out the premium tax credit and reconciles any help already paid. Nothing goes on the return unless there is help to reconcile.',
    byHand:
      'The form does not print how many people are in the family, and the credit depends on it. Ask the client before working it out. Cover through December is not the same as all year.',
  },
  'K-1': {
    name: 'K-1 (partnership or S corporation)',
    what: 'A business reporting one partner’s or one shareholder’s share of its year.',
    why: 'A partnership or S corporation has to give this to everyone with an interest in it.',
    applies:
      'Each item lands on a different part of the return — some on Schedule C, some on Schedule D, some as investment income. It is the single most detailed form the app reads.',
    byHand:
      'A K-1 does not say whether it is a partnership or an S corporation, and the two are taxed very differently. The form number tells you: Form 1065 is a partnership, Form 1120-S is an S corporation. Confirm it before filing.',
  },
};

const UNKNOWN: FormGuidance = {
  name: 'Unknown document',
  what: 'A document the app has not recognised as a tax form.',
  why: 'It may not be a tax form at all.',
  applies: 'Nothing from it is on the return.',
  byHand: 'Look at it and, if it is a form the app supports, drop it on the case again to read it.',
};

/** What the app can tell a preparer about a form type, or a plain fallback. */
export function formGuidance(formType: string | null | undefined): FormGuidance {
  if (!formType) return UNKNOWN;
  return FORM_GUIDANCE[formType as ClassifiableFormType] ?? {
    ...UNKNOWN,
    name: formType,
  };
}
