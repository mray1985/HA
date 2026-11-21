const fs=require('node:fs')
const {PDFDocument, rgb}=require('../individual/node_modules/pdf-lib')
async function build(){
 const source=await PDFDocument.load(fs.readFileSync(process.argv[2]))
 const pdf=await PDFDocument.create(),page=pdf.addPage([612,792])
 const [background]=await pdf.embedPages([source.getPages()[3]])
 page.drawPage(background)
 page.drawText('FICTIONAL TRAINING DOCUMENT - HOOD ACCOUNTANT',{x:48,y:760,size:10,color:rgb(.45,0,0)})
 const prefix='topmostSubform[0].CopyB[0].Col_Right[0].'
 for(const [name,x,width,value] of [['Box1_ReadOrder[0].f2_09[0]',333.2,118.4,'41050.00'],['f2_10[0]',455.6,118.4,'3500.00']]){
   const field=pdf.getForm().createTextField(prefix+name)
   field.setText(value);field.addToPage(page,{x,y:708,width,height:12,borderWidth:0});field.setFontSize(10)
 }
 pdf.setSubject('HA synthetic W-2 2025');pdf.setTitle('HA synthetic W-2 2025')
 fs.writeFileSync(__dirname+'/samples/HA-Sample-W2-2025.pdf',await pdf.save())
}
build().catch(e=>{console.error(e);process.exitCode=1})
