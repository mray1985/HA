import {calculateTaxTableTax} from '../../individual/shared/src/engine/brackets'
import {getStandardDeduction} from '../../individual/shared/src/constants/taxConstants'
import {FilingStatus} from '../../individual/shared/src/types/index'

type Slip = {wages: string, withheld: string}
export type Case = {year:number, slips:Slip[], confirmed:boolean}
function cents(raw:string):number {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw)) throw Error(raw === '' ? 'Enter the missing W-2 amount. Enter 0 if the box is zero.' : 'Use dollars and up to two decimal places.')
  const [dollars, fraction=''] = raw.split('.')
  return Number(dollars)*100 + Number(fraction.padEnd(2,'0'))
}
export function review(facts:Case) {
  if (![2024,2025].includes(facts.year)) throw Error('This tax year is awaiting form and calculation verification.')
  if (!facts.confirmed) throw Error('Confirm the sample facts to calculate this return.')
  if (!facts.slips.length) throw Error('Add a W-2 to begin.')
  const total=(key:keyof Slip)=>Math.floor((facts.slips.reduce((sum,s)=>sum+cents(s[key]),0)+50)/100)
  const wages=total('wages'), withheld=total('withheld')
  if(wages<40000 || wages>100000) throw Error('This verified sample covers total wages from $40,000 through $100,000.')
  const deduction=getStandardDeduction(facts.year)[FilingStatus.Single]
  const taxable=wages-deduction
  const {tax,row}=calculateTaxTableTax(taxable,FilingStatus.Single,facts.year)
  const refund=Math.max(0,withheld-tax), due=Math.max(0,tax-withheld)
  const amounts:Record<string,number>={'1a':wages,'1z':wages,'9':wages,'14':deduction,'15':taxable,'16':tax,'18':tax,'22':tax,'24':tax,'25a':withheld,'25d':withheld,'33':withheld,'34':refund,'35a':refund,'37':due}
  for(const line of facts.year===2025?['11a','11b']:['11']) amounts[line]=wages
  amounts[facts.year===2025?'12e':'12']=deduction
  return {amounts, wages, withheld, deduction, taxable, tax, refund, due, row}
}

// This sample importer accepts the single-page Copy B fixture with two fillable boxes.
// Images, flattened PDFs, and other revisions require separate extraction and review.
import {PDFDocument} from '../../individual/node_modules/pdf-lib'
export async function readSampleW2(bytes:ArrayBuffer) {
  if(bytes.byteLength>2_000_000) throw Error('Use a sample PDF under 2 MB.')
  const pdf=await PDFDocument.load(bytes)
  if(pdf.getSubject()!=='HA synthetic W-2 2025'||pdf.getPageCount()!==1)
    throw Error('Choose a synthetic 2025 W-2 made from the supplied practice PDF.')
  const fields=pdf.getForm()
  const names=fields.getFields().map(f=>f.getName())
  function field(suffix:string) {
    const key=names.find(n=>n.includes('.CopyB[')&&n.endsWith(suffix))
    if(!key)throw Error('The sample W-2 is missing a required field.')
    const raw=fields.getTextField(key).getText()?.trim()??''
    if(raw)cents(raw)
    return raw
  }
  return {wages:field('.f2_09[0]'),withheld:field('.f2_10[0]')}
}
