export const TERMS = [
  { term: 'Deduction', text: 'An allowed amount that reduces the income used to calculate income tax. A deduction is not a dollar-for-dollar refund.', source: 'https://www.irs.gov/credits-and-deductions-for-individuals' },
  { term: 'Credit', text: 'An allowed amount that reduces tax. Refundable credits can produce a refund beyond the tax owed; eligibility rules apply.', source: 'https://www.irs.gov/credits-and-deductions-for-individuals' },
  { term: 'Withholding', text: 'Tax paid ahead from a paycheck or other payment. Your return reconciles those payments with your actual tax.', source: 'https://www.irs.gov/individuals/employees/tax-withholding' },
  { term: 'Self-employment tax', text: 'Social Security and Medicare tax on qualifying net earnings from self-employment. The standard deduction does not erase this tax.', source: 'https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes' },
  { term: 'Schedule C', text: 'The form generally used by a sole proprietor to report business income and expenses. HAKeeper entries need review before they become return entries.', source: 'https://www.irs.gov/forms-pubs/about-schedule-c-form-1040' },
  { term: 'Form 1040', text: 'The individual federal income tax return. Schedules and other forms supply additional details when your situation requires them.', source: 'https://www.irs.gov/forms-pubs/about-form-1040' },
  { term: 'Estimated tax', text: 'Payments made during the year toward tax, often for income without enough withholding. The amount and timing both matter.', source: 'https://www.irs.gov/individuals/employees/tax-withholding' },
];
export const QUESTIONS = [
  { question: 'You qualify for a $500 deduction. What does it reduce?', options: ['Taxable income', 'Tax owed by exactly $500', 'Every kind of tax'], answer: 0, why: TERMS[0].text },
  { question: 'Does the standard deduction wipe out self-employment tax?', options: ['Yes', 'No'], answer: 1, why: TERMS[3].text },
  { question: 'What is federal income tax withholding?', options: ['An employer fee', 'Tax paid ahead', 'An automatic tax credit'], answer: 1, why: TERMS[2].text },
  { question: 'What should happen before HAKeeper expenses enter Schedule C?', options: ['Deduct every bank withdrawal', 'Review business purpose and category', 'Choose the biggest possible refund'], answer: 1, why: 'Review records, business purpose, tax year, business-use allocation, and category. A payment alone does not establish deductibility.' },
  { question: 'What is the goal of the tax game?', options: ['Always get the biggest refund', 'Understand the return and make accurate decisions', 'Guess missing information'], answer: 1, why: 'A refund is a reconciliation of tax and payments, not a measure of success. Accuracy and understanding earn points here.' },
];
export const LESSONS = [
  { title: 'Deductions and credits', text: `${TERMS[0].text} ${TERMS[1].text}` },
  { title: 'HAKeeper to Schedule C', text: 'Keep income and expense records throughout the year. Separate personal spending from business expenses. Review the business purpose, tax year, business-use allocation, and category of each entry. In HAKeeper, choose a business and review the proposed expense transfer before applying it to Schedule C. Transfers and personal payments are not automatically deductible.' },
  { title: 'Withholding and Taxmas', text: `${TERMS[2].text} Too much withholding means waiting to use your money. Too little may mean a balance due or penalty. Check withholding when your work or family situation changes.` },
];
