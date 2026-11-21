"""Independently read the IRS printed labels beside the actual PDF widgets."""
from pathlib import Path
import re
import fitz
root=Path(__file__).resolve().parents[2]
for app in ['individual','preparer']:
    base=root/app
    extract=(base/'client/src/services/priorYearImporter.ts').read_text()
    for year,filename in [(2024,'f1040-2024.pdf'),(2025,'f1040.pdf')]:
        doc=fitz.open(base/'client/public/irs-forms'/filename)
        page=doc[1]
        words=page.get_text('words')
        ids={}
        for field in page.widgets():
            r=field.rect
            if r.x0<395 or field.field_type_string!='Text':continue
            for x,y,x1,y1,line,*_ in words:
                if r.x0-22<x<r.x0 and abs(y+y1-r.y0-r.y1)<10:
                    ids[line]=field.field_name.split('.')[-1]
        marker='FORM_1040_EXTRACT_FIELDS'+('_2024' if year==2024 else '')+' ='
        block=extract.split(marker)[1].split('} as const')[0]
        for entry,line in [('totalTax','24'),('estimatedPmts','26'),('totalPayments','33'),('refund','35a'),('amountOwed','37')]:
            assert ids[line] in re.search(entry+r':[^\n]+',block)[0]
        if year==2025:
            mapping=(base/'shared/src/constants/irsForm1040Map.ts').read_text()
            for line in ['34','35a','36','37','38']:
                block=next(b for b in mapping.split('pdfFieldName:') if f"formLabel: 'Line {line}:" in b)
                assert ids[line] in block.splitlines()[0]
print('30 repository import/export mappings checked against printed IRS line labels.')
