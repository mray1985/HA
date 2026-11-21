// Validate every in-range table row against entries transcribed from the IRS instructions.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const box={};vm.runInNewContext(fs.readFileSync(__dirname+'/../dist/engine.js','utf8'),box)
const review=(year,wages,withheld='3500')=>box.HATax.review({year,slips:[{wages,withheld}],confirmed:true})
const rows=JSON.parse(fs.readFileSync(__dirname+'/table-fixtures.json','utf8'))
let checked=0
for(const [year,deduction] of [[2024,14600],[2025,15750]]){
  for(const [lo,value] of rows[year]){
    for(const income of [lo,lo+49]){
      const wages=income+deduction
      if(wages<40000||wages>100000)continue
      const r=review(year,String(wages));assert.equal(r.taxable,income);assert.equal(r.deduction,deduction);assert.equal(r.tax,value);checked++
    }
  }
  assert.equal(review(year,'40000.49').wages,40000)
  assert.equal(review(year,'40000.50').wages,40001)
  assert.throws(()=>review(year,'39999'))
  assert.throws(()=>review(year,'100001'))
}
assert.throws(()=>review(2026,'41050'))
assert.equal(review(2025,'41050').refund,699)
assert.equal(review(2025,'41050','0').due,2801)
for(const invalid of ['','-1','oops','1e3','1.005'])assert.throws(()=>review(2025,'41050',invalid))
console.log(checked+' IRS Tax Table boundary comparisons passed; blank, invalid, rounding, year and scope checks passed.')
