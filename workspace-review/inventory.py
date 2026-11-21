"""Index IRS catalog rows by publication revision. Applicability requires separate review."""
import concurrent.futures, csv, pathlib, re, subprocess, urllib.parse
from lxml import html
ROOT=pathlib.Path(__file__).resolve().parent
BASE='https://www.irs.gov'
def fetch(url):
    return html.fromstring(subprocess.check_output(['curl','--fail','--retry','2','--max-time','45','-LsS',url]))
def records(year):
    url=f'{BASE}/prior-year-forms-and-instructions?date={year}&items_per_page=200'
    first=fetch(url)
    pages=[int(x.split('page=')[-1]) for x in first.xpath('//a[contains(normalize-space(.),"Last page")]/@href')]
    docs=[first]
    for n in range(1,max(pages or [0])+1):docs.append(fetch(url+f'&page={n}'))
    rows=[]
    for d in docs:
        for r in d.xpath('//table//tr[td]'):
            cells=r.xpath('td')
            item,title,revision=[' '.join(c.text_content().split()) for c in cells]
            assert str(year) in revision
            source=urllib.parse.urljoin(BASE,cells[0].xpath('a/@href')[0])
            rows.append((item,title,revision,source))
    return rows
columns=['inventory_year','official_item','official_title','revision','source_url','instructions_url','family_candidate','year_applicability','filing_method','dependencies','calculation','PDF_mapping','MeF','verification']
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    groups=list(pool.map(records,[2024,2025,2026]))
with (ROOT/'coverage.csv').open('w',newline='') as out:
    w=csv.writer(out);w.writerow(columns)
    for year,group in zip([2024,2025,2026],groups):
        refs={n:u for n,t,r,u in group if n.startswith('Instruction')}
        for n,t,r,u in group:
            family=next((f for f in ['1120-S','1040','1065','1120','1041','706','709','990','941','940','943','944','945','720','2290'] if re.search(r'(?<!\d)'+f+r'(?!\d)',n)), 'unclassified')
            sample=n=='Form 1040' and year in (2024,2025) and r==str(year)
            inst=refs.get(n.replace('Form ','Instruction ',1),'') if n.startswith('Form ') else ''
            w.writerow([year,n,t,r,u,inst,family,'verified for sample' if sample else 'review required','review print only' if sample else 'unverified','W-2 boxes 1 and 2; confirmed profile' if sample else 'unreconciled','single W-2-only sample' if sample else 'unassessed','partial verified fields' if sample else 'unassessed','disabled','sample tested' if sample else 'catalog metadata only'])
print([len(g) for g in groups])
