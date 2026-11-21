const el=id=>document.getElementById(id)
const documentURLs=new Map()
const money=v=>v.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})
const seed=()=>({wages:'41050.00',withheld:'3500.00',seed:true})
const slips=[seed()]
const draftKey=year=>'ha.review.v1.'+year
function restore(){
  let draft=null
  try{draft=JSON.parse(sessionStorage.getItem(draftKey(el('year').value)))}catch{}
  const valid=draft&&Array.isArray(draft.slips)&&draft.slips.length>0&&draft.slips.every(s=>s&&typeof s.wages==='string'&&typeof s.withheld==='string')
  slips.splice(0,slips.length,...(valid?draft.slips:[seed()]))
  el('confirm').checked=valid?draft.confirmed===true:true
}
function save(){
  try{sessionStorage.setItem(draftKey(el('year').value),JSON.stringify({slips,confirmed:el('confirm').checked}))}catch{}
}
const names={'1a':'W-2 wages','1z':'Total wages','9':'Total income','11':'Adjusted gross income','11a':'Adjusted gross income','11b':'Adjusted gross income carried forward','12':'Standard deduction','12e':'Standard deduction','14':'Total deductions','15':'Taxable income','16':'Income tax','18':'Tax before credits','22':'Tax after credits','24':'Total tax','25a':'W-2 withholding','25d':'Total withholding','33':'Total payments','34':'Overpayment','35a':'Refund requested','37':'Amount owed'}
const income=['1a','1z','9','11','11a','11b'], deduction=['12','12e','14'], payment=['25a','25d','33'], settlement=['34','35a','37']
let selected='1a', result=null
function panel(id){document.querySelectorAll('.grid section').forEach(s=>s.classList.toggle('shown',s.id===id));document.querySelectorAll('[data-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.panel===id)))}
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>panel(b.dataset.panel))
function pick(id,scroll=false){
  selected=id;el('line').value=id
  const all=settlement.includes(id), d=deduction.includes(id), p=payment.includes(id), w=income.includes(id)
  document.querySelectorAll('[data-box]').forEach(b=>b.classList.toggle('active',all || (b.dataset.box==='wages'?!d&&!p:p)))
  el('profile').classList.toggle('active',!w&&!p)
  document.querySelectorAll('[data-line]').forEach(b=>b.classList.toggle('active',b.dataset.line===id))
  if(scroll && !matchMedia('(max-width:850px)').matches)document.querySelector('[data-line="'+id+'"]')?.scrollIntoView({block:'nearest'})
  if(!result){el('detail').textContent='Resolve the intake question above to see the calculation.';return}
  const r=result, amt=r.amounts[id], parts=slips.map(s=>Number(s[p?'withheld':'wages']).toFixed(2))
  let explanation,formula
  if(w||p){explanation=p?'Your employers already sent this amount toward your federal income tax.':'Your employers reported these wages in box 1. With wages as your only income and no adjustments, the same total carries into adjusted gross income.';formula=parts.join(' + ')+' → '+money(amt)}
  else if(d){explanation='Your filing status, age and sample facts qualify you for this year’s single standard deduction.';formula=el('year').value+' · Single → '+money(amt)}
  else if(id==='15'){explanation='The standard deduction reduces the wages subject to federal income tax.';formula=money(r.wages)+' − '+money(r.deduction)+' = '+money(amt)}
  else if(all){explanation=id==='37'?'Any tax left after withholding is the amount owed before a possible penalty.':'Withholding above the tax is an overpayment. This case requests all of it back.';formula=id==='37'?'max(0, '+money(r.tax)+' − '+money(r.withheld)+')':'max(0, '+money(r.withheld)+' − '+money(r.tax)+')'}
  else{explanation='Find your taxable income in the IRS Tax Table and read across to the single column. With no other taxes or credits, that amount carries to total tax.';formula=money(r.row.atLeast)+' ≤ '+money(r.taxable)+' < '+money(r.row.lessThan)+' → '+money(r.tax)}
  el('detail').replaceChildren()
  for(const [tag,content] of [['h3','Line '+id+' · '+names[id]],['p',money(amt)],['p',el('mode').value==='Visual'?formula:explanation],['small',el('year').value+' Form 1040 instructions · '+(all?'Payments and refund':p?'Withholding':w?'Income':d?'Standard deduction':id==='15'?'Taxable income':'Tax Table')]]){
    const node=document.createElement(tag);node.textContent=content;if(tag==='p')node.className='math';el('detail').append(node)
  }
}
function renderSlips(){
  el('slips').replaceChildren()
  slips.forEach((slip,i)=>{
    const group=document.createElement('fieldset'), legend=document.createElement('legend');legend.textContent='Employer '+(i+1);group.append(legend)
    for(const [key,title,line] of [['wages','Box 1 · Wages','1a'],['withheld','Box 2 · Federal income tax withheld','25a']]){
      const label=document.createElement('label'),input=document.createElement('input')
      label.textContent=title;input.value=slip[key];input.inputMode='decimal';input.autocomplete='off';input.dataset.box=key;input.oninput=()=>{slip[key]=input.value;slip.seed=false;refresh()};input.onfocus=input.onpointerenter=()=>pick(line);label.append(input);group.append(label)
      if(slip.extracted){
        input.readOnly=true
        const override=document.createElement('button')
        override.textContent='Correct '+(key==='wages'?'wages':'withholding')
        override.onclick=()=>{
          const newValue=window.prompt('Corrected dollar amount',slip[key])
          if(newValue===null)return
          if(!/^\d{1,8}(\.\d{1,2})?$/.test(newValue)){window.alert('Enter dollars and up to two decimal places.');return}
          const reason=window.prompt('Why is this confirmed W-2 value being corrected?')
          if(!reason?.trim())return
          slip.history??=[]
          slip.history.push({box:key,from:slip[key],to:newValue,reason:reason.trim(),when:new Date().toISOString()})
          slip[key]=newValue;renderSlips();refresh();pick(line)
        }
        group.append(override)
        const note=document.createElement('small');note.textContent='Copy B · page 1 · box '+(key==='wages'?'1':'2')+' · confirmed PDF value '+(slip.extracted[key]||'missing');group.append(note)}
    }
    if(slip.documentHash && documentURLs.has(slip.documentHash)){
      const link=document.createElement('a');link.href=documentURLs.get(slip.documentHash);link.target='_blank';link.rel='noopener';link.textContent='Open source PDF · page 1';group.append(link)
    }
    if(slip.history?.length){
      const audit=document.createElement('details'),title=document.createElement('summary');title.textContent='Correction history';audit.append(title)
      for(const h of slip.history){const entry=document.createElement('p');entry.textContent=h.when+' · '+h.box+' · '+h.from+' → '+h.to+' · '+h.reason;audit.append(entry)}
      group.append(audit)
    }
    if(slips.length>1){const b=document.createElement('button');b.textContent='Remove W-2';b.onclick=()=>{slips.splice(i,1);renderSlips();refresh()};group.append(b)}
    el('slips').append(group)
  })
}
function renderForms(){
  el('pages').replaceChildren();el('line').replaceChildren()
  const form=forms[el('year').value];if(!form)return
  const groups=form.pages.map((url,i)=>{const box=document.createElement('div');box.className='paper';const img=new Image();img.src=url;img.alt='Official '+el('year').value+' Form 1040, page '+(i+1);const stamp=document.createElement('span');stamp.className='stamp';stamp.textContent='HA · SYNTHETIC REVIEW COPY';box.append(img,stamp);el('pages').append(box);return box})
  for(const [id,[page,x,y,width,height]] of Object.entries(form.fields).sort((a,b)=>a[1][0]-b[1][0]||a[1][2]-b[1][2])){
    el('line').add(new Option(id+' · '+names[id],id));const b=document.createElement('button');b.dataset.line=id;Object.assign(b.style,{left:x+'%',top:y+'%',width:width+'%',height:height+'%'});b.onpointerenter=b.onfocus=b.onclick=()=>pick(id);groups[page].append(b)
  }
  selected=form.fields[selected]?selected:'1a'
}
function refresh(){
  save()
  try{result=HATax.review({year:Number(el('year').value),confirmed:el('confirm').checked,slips});el('status').textContent='Calculated · Review only'}catch(e){result=null;el('status').textContent=e.message}
  for(const b of document.querySelectorAll('[data-line]')){const id=b.dataset.line;b.textContent=result?result.amounts[id].toLocaleString('en-US'):'';b.setAttribute('aria-label','Line '+id+', '+names[id]+', '+(b.textContent||'awaiting information'))}
  el('result').textContent=result?(result.due?'Balance due '+money(result.due):'Refund '+money(result.refund)):'Awaiting information'
  el('print').disabled=!result;pick(selected)
}
el('year').onchange=()=>{cancelImport();restore();renderSlips();renderForms();refresh()};el('confirm').onchange=refresh;el('mode').onchange=()=>pick(selected);el('line').onchange=()=>pick(el('line').value,true)
el('add').onclick=()=>{slips.push({wages:'',withheld:''});renderSlips();refresh();el('slips').lastChild.querySelector('input').focus()}
el('print').onclick=()=>window.print()
restore();renderSlips();renderForms();refresh();panel('source')
if(location.protocol!=='file:' && 'serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{})
el('fixture').href=sampleURL
let candidate=null
let uploadVersion=0
function cancelImport(){uploadVersion++;candidate=null;el('apply').hidden=true;el('upload').value='';el('pending').textContent=''}
el('upload').onchange=async()=>{
  const version=++uploadVersion,file=el('upload').files[0]
  el('apply').hidden=true;candidate=null
  if(!file)return
  try{
    if(el('year').value!=='2025')throw Error('Select 2025 for this practice W-2.')
    if(file.size>2_000_000)throw Error('Use the supplied practice PDF, under 2 MB.')
    const bytes=await file.arrayBuffer()
    const amounts=await HATax.readSampleW2(bytes)
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
    if(version!==uploadVersion)return
    if(slips.some(s=>s.documentHash===hash))throw Error('This exact W-2 is already in the return.')
    candidate={...amounts,documentHash:hash,extracted:{...amounts},page:1}
    el('pending').textContent='Copy B, page 1. Box 1: '+(amounts.wages||'missing')+'. Box 2: '+(amounts.withheld||'missing')+'. Review both amounts before confirming.'
    el('apply').textContent=slips.length===1 && slips[0].seed?'Confirm and replace example W-2':'Confirm and add W-2'
    el('apply').hidden=false
  }catch(e){if(version===uploadVersion)el('pending').textContent=e.message}
}
el('apply').onclick=()=>{
  if(!candidate)return
  const file=el('upload').files[0]
  if(file)documentURLs.set(candidate.documentHash,URL.createObjectURL(file))
  if(slips.length===1&&slips[0].seed)slips.splice(0,1)
  slips.push(candidate);cancelImport();renderSlips();refresh()
}
