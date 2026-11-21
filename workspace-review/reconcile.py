"""Join the public IRS accepted-form lists to product catalog rows. Keep source multiplicities."""
import csv, io, pathlib, re, subprocess, sys
from openpyxl import load_workbook
ROOT=pathlib.Path(__file__).resolve().parent
urls={
2024:'https://www.irs.gov/pub/irs-schema/tax-year-2024-accepted-forms-schedules-individual-tax-returns-extensions-11212024.xlsx',
2025:'https://www.irs.gov/pub/irs-efile/tax-year-2025-accepted-forms-schedules-individual-tax-returns-extensions.xlsx',
2026:'https://www.irs.gov/pub/irs-efile/tax-year-2026-accepted-forms-schedules-individual-tax-returns-extensions.xlsx'}
def norm(text):return re.sub(r'[^A-Z0-9]','',text.upper())
catalog={}
for r in csv.DictReader((ROOT/'coverage.csv').open()):
    catalog.setdefault((int(r['inventory_year']),norm(r['official_item'])),[]).append(r)
with (ROOT/'individual-mef.csv').open('w',newline='') as f:
    w=csv.writer(f)
    w.writerow(['tax_year','accepted_list_item','return_family','IRS_list_value','catalog_match','catalog_urls','source_workbook','worksheet','worksheet_row','HA_transmission'])
    for year,url in urls.items():
        raw=(pathlib.Path(sys.argv[1])/f'accepted{year}.xlsx').read_bytes() if len(sys.argv)>1 else subprocess.check_output(['curl','--fail','--retry','2','--max-time','40','-LsS',url])
        sheet=load_workbook(io.BytesIO(raw),read_only=True,data_only=True).active
        header=None
        for number,row in enumerate(sheet.values,1):
            if 'Form' in row:
                start=row.index('Form')
                header=[(i,str(v).strip()) for i,v in enumerate(row) if i>start and v is not None]
                continue
            if not header or not isinstance(row[start],str) or not any(isinstance(row[i],int) for i,_ in header):continue
            name=row[start].strip();matches=catalog.get((year,norm(name)),[])
            for i,fam in header:
                w.writerow([year,name,fam,row[i],'identifier matched' if matches else 'needs crosswalk',' | '.join(r['source_url'] for r in matches),url,sheet.title,number,'disabled'])
