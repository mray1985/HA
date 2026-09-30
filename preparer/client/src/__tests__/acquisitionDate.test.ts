import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateForm1040, FilingStatus } from '@hatax/engine';
import { clearReturnCache, createReturn, getReturn, updateReturn } from '../api/client';
import { clearRecordCache } from '../services/caseRecords';
import { buildCaseReview } from '../services/caseReview';
import { recordAcquisition } from '../services/preparerDecisions';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

let id = '';
const review = () => {
  const tr = getReturn(id);
  return buildCaseReview({ taxReturn: tr, calculation: calculateForm1040(tr), facts: [], documents: [] });
};

describe('special depreciation waits for the date acquired (TAX-001)', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    clearReturnCache();
    clearRecordCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    id = createReturn(2025).id;
    updateReturn(id, {
      firstName: 'Sam', lastName: 'Park', filingStatus: FilingStatus.Single,
      businesses: [{ id: 'b', businessName: 'Park Studio', principalBusinessCode: '541430', accountingMethod: 'cash' }],
      income1099NEC: [{ id: 'n', payerName: 'Client Co', amount: 80000 }],
      depreciationAssets: [{ id: 'cam', description: 'Camera', cost: 10000, dateInService: '2025-02-01', propertyClass: 5, businessUsePercent: 100 }],
    } as never);
  });

  it('blocks the case and offers the date acquired', () => {
    const item = review().items.find((i) => i.id === 'unsupported:FED.BONUS_DEPRECIATION.168K:cam');
    expect(item).toMatchObject({ category: 'BLOCKING', action: { kind: 'acquisition_date', assetId: 'cam' } });
  });

  it('takes 40% once the date says the asset was acquired before January 20, 2025', () => {
    expect(recordAcquisition(id, 'cam', { acquisitionDate: '2024-12-20' })).toMatchObject({ ok: true });
    expect(getReturn(id).depreciationAssets?.[0]?.acquisitionDate).toBe('2024-12-20');
    expect(review().items.some((i) => i.id.startsWith('unsupported:FED.BONUS'))).toBe(false);
    const asset = calculateForm1040(getReturn(id)).scheduleC?.form4562Result?.assetDetails.find((a) => a.assetId === 'cam');
    expect(asset).toMatchObject({ bonusDepreciation: 4000, macrsDepreciation: 1200 });
  });

  it('refuses a date after the asset was placed in service', () => {
    expect(recordAcquisition(id, 'cam', { acquisitionDate: '2025-03-01' })).toMatchObject({ ok: false });
  });
});
