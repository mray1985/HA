"""Build portable, local-only release from HA's original PDFs and engine."""
import base64, hashlib, json, os, pathlib, shutil, subprocess
import fitz
ROOT=pathlib.Path(__file__).resolve().parent
APP=ROOT.parent/'individual'
OUT=ROOT/'dist'
OUT.mkdir(exist_ok=True)
engine=ROOT/'src/engine.ts'
esbuild=os.environ.get('ESBUILD') or str(APP/'node_modules/.bin/esbuild')
subprocess.run([esbuild,str(engine),'--bundle','--format=iife','--global-name=HATax',f'--outfile={OUT}/engine.js'],check=True)
data={}
common='1a 1z 9 14 15 16 18 22 24 25a 25d 33 34 35a 37'.split()
for year,name,sha in [(2024,'f1040-2024.pdf','0a7a54354283044cb41373c6faabfa50955d44bdf91b4b76fa1ca2bf13f6d718'),(2025,'f1040.pdf','3d31c226df0d189ced80e039d01cf0f8820c1019681a0f0ca6264de277b7e982')]:
    path=APP/'client/public/irs-forms'/name
    assert hashlib.sha256(path.read_bytes()).hexdigest()==sha
    doc=fitz.open(path)
    fields={}
    pages=[]
    expected=set(common+('11 12' if year==2024 else '11a 11b 12e').split())
    for i,page in enumerate(doc):
        words=page.get_text('words')
        for w in page.widgets():
            r=w.rect
            if w.field_type_string!='Text' or r.x0<393:continue
            for x,y,x1,y1,label,*_ in words:
                if label in expected and r.x0-22<x<r.x0 and abs(y+y1-r.y0-r.y1)<10:
                    assert label not in fields
                    fields[label]=[i,*[round(v,3) for v in (100*r.x0/612,100*r.y0/792,100*r.width/612,100*r.height/792)]]
        raw=page.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False).tobytes('png')
        pages.append('data:image/png;base64,'+base64.b64encode(raw).decode())
    assert set(fields)==expected
    data[year]=dict(pages=pages,fields=fields)
html=(ROOT/'src/page.html').read_text().replace('/* FORM_DATA */',json.dumps(data)).replace('/* SAMPLE */',json.dumps('data:application/pdf;base64,'+base64.b64encode((ROOT/'samples/HA-Sample-W2-2025.pdf').read_bytes()).decode())).replace('/* ENGINE */',(OUT/'engine.js').read_text()).replace('/* APPLICATION */',(ROOT/'src/app.js').read_text()).replace('/* LICENSE */','/* '+(ROOT.parent/'LICENSE').read_text()+' */')
(OUT/'index.html').write_text(html)
for f in ['manifest.webmanifest','sw.js','icon192.png','icon512.png']:shutil.copyfile(ROOT/'src'/f,OUT/f)
for app in ['individual','preparer']:
    target=ROOT.parent/app/'client/public/return-workspace'
    shutil.copytree(OUT,target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('engine.js'))
