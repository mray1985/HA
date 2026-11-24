import { describe, expect, it } from 'vitest';
import { correlateTaxPacket } from '../services/taxPacketCorrelation';

describe('loss signs in supporting statements', () => {
  for (const line of ['Ordinary business income (loss) -1250.50', 'Ordinary business income (loss): -1250.50', 'Ordinary business income (loss) ($1,250.50)', 'Ordinary business income (loss) -$1,250.50', 'Ordinary business income (loss) $-1,250.50']) {
    it(`preserves the loss in ${line}`, () => {
      const lines = ['Schedule K-1 (Form 1065) 2025', 'Entity EIN: 12-3456789', 'Recipient TIN: 000-00-0000', line];
      const report = correlateTaxPacket(lines.map((text, i) => ({ documentId: 'synthetic', fileName: 'synthetic.pdf', page: 1, text, x: 30, y: 20 + i * 20, width: 500, height: 10 })));
      expect(report.candidates[0].value).toBe(-1250.50);
    });
  }
  for (const amount of ['($100', '$100)', '(100', '100)', '100.123', '100 200', '-100 -200']) {
    it(`holds ambiguous or malformed cells ${amount} for review`, () => {
      const lines = ['Schedule K-1 (Form 1065) 2025', `Ordinary business income (loss): ${amount}`];
      const report = correlateTaxPacket(lines.map((text, i) => ({ documentId: 'synthetic', fileName: 'synthetic.pdf', page: 1, text, x: 30, y: 20 + i * 20, width: 500, height: 10 })));
      expect(report.candidates[0].value).toBeNull();
    });
  }
});
