"""Generate review queues for the requested families, including catalog omissions."""
import csv, pathlib, re
root=pathlib.Path(__file__).resolve().parent
def read(name):
    with (root/name).open() as f:return list(csv.DictReader(f))
def key(s):return re.sub('[^A-Z0-9]','',s.upper())
catalog=read('coverage.csv');mef=read('individual-mef.csv')
requested='1040 1040-SR 1040-NR 1040-SS 1040-X 1040-ES 1040-V 8949 4797 6252 6781 2439 4562 8829 6198 8582 461 8995 8995-A 7203 2441 8863 8814 8615 8880 8862 5695 8936 3800 8606 5329 8889 8853 8962 8965 6251 8959 8960 4137 8919 4972 1116 2555 8938 8621 5471 8865 982 4684 8283 8379 8857 1310 2210 8867 8879 8878 8453 8948 4868 8888'.split()
families={'individual':['Form '+x for x in requested]+['Form 1040 (Schedule '+s+')' for s in '1 1-A 2 3 A B C D E F H J R SE EIC 8812'.split()],
'partnership':['Form 1065'],'corporation':['Form 1120'],'S corporation':['Form 1120-S'],'fiduciary':['Form 1041'],'estate':['Form 706'],'gift':['Form 709'],'exempt organization':['Form '+s for s in ['990','990-EZ','990-PF','990-T']],'employment':['Form '+s for s in ['940','941','943','944','945']],'excise':['Form '+s for s in ['720','2290','8849']]}
dest=root/'modules';dest.mkdir(exist_ok=True)
for name,seeds in families.items():
    with (dest/(name.replace(' ','-')+'.csv')).open('w',newline='') as file:
        w=csv.writer(file);w.writerow(['year','item','official title','revision','IRS source','instructions','dependencies','implementation','PDF','public individual MeF listing','HA filing','verification'])
        for year in ['2024','2025','2026']:
            items=dict.fromkeys(seeds)
            for r in catalog:
                if r['inventory_year']==year and any(r['official_item'].startswith(seed+' (Schedule') for seed in seeds):
                    items[r['official_item']]=None
            for item in items:
                hits=[r for r in catalog if r['inventory_year']==year and key(r['official_item'])==key(item)]
                accepted=any(r['tax_year']==year and key(r['accepted_list_item'])==key(item) for r in mef)
                for r in hits or [{}]:
                    w.writerow([year,item,r.get('official_title',''),r.get('revision',''),r.get('source_url',''),r.get('instructions_url',''),r.get('dependencies','unreconciled'),r.get('calculation','unassessed'),r.get('PDF_mapping','unassessed'),'listed' if accepted else 'unreconciled','disabled',r.get('verification','verify current or continuous revision and tax-year applicability')])
