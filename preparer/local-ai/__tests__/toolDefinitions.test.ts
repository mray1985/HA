import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TAX_TOOL_NAMES, TOOL_FIELD_SCHEMAS } from '../src/taxTools.js';
import { taxToolDefinitions, zodToJsonSchema } from '../src/toolDefinitions.js';

describe('taxToolDefinitions', () => {
  const defs = taxToolDefinitions();

  it('defines every tax tool exactly once', () => {
    expect(defs.map((d) => d.name)).toEqual([...TAX_TOOL_NAMES]);
  });

  it('exposes exactly the field names the validator accepts', () => {
    for (const d of defs) {
      if (d.name === 'set_filing_status_candidate') continue;
      const props = Object.keys((d.parameters as { properties: object }).properties);
      expect(props).toEqual(Object.keys(TOOL_FIELD_SCHEMAS[d.name].shape));
      expect(d.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('keeps optional amounts optional so missing values are omitted, not zeroed', () => {
    const w2 = defs.find((d) => d.name === 'add_w2')!.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(w2.required).toBeUndefined();
    expect(w2.properties.wages).toEqual({ type: 'number' });
    expect(w2.properties.box12).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string', minLength: 1 }, amount: { type: 'number' } },
        required: ['code', 'amount'],
        additionalProperties: false,
      },
    });
  });

  it('constrains the filing-status candidate to the five statuses', () => {
    const fs = defs.find((d) => d.name === 'set_filing_status_candidate')!.parameters as { properties: { status: { enum: string[] } }; required: string[] };
    expect(fs.required).toEqual(['status']);
    expect(fs.properties.status.enum).toEqual([
      'single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household', 'qualifying_surviving_spouse',
    ]);
  });
});

describe('zodToJsonSchema', () => {
  it('refuses zod types it does not know instead of emitting a loose schema', () => {
    expect(() => zodToJsonSchema(z.union([z.string(), z.number()]))).toThrow(/unsupported/);
  });
});
