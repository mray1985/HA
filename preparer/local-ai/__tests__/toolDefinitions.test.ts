import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RETURN_TOOL_NAMES } from '../src/returnTools.js';
import { fieldSchemaFor, TAX_TOOL_NAMES } from '../src/taxTools.js';
import { taxToolDefinitions, zodToJsonSchema } from '../src/toolDefinitions.js';

describe('taxToolDefinitions', () => {
  const defs = taxToolDefinitions();

  it('defines every tax tool and both return tools exactly once', () => {
    expect(defs.map((d) => d.name)).toEqual([...TAX_TOOL_NAMES, ...RETURN_TOOL_NAMES]);
  });

  it('exposes exactly the field names the validator accepts', () => {
    for (const d of defs) {
      if (d.name === 'set_filing_status_candidate' || d.name === 'calculate_return' || d.name === 'run_diagnostics') continue;
      const props = Object.keys((d.parameters as { properties: object }).properties);
      expect(props).toEqual(Object.keys(fieldSchemaFor(d.name).shape));
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

  it('gives a model the same limits the validator enforces', () => {
    const props = (name: string) => (defs.find((d) => d.name === name)!.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props('add_dependent').monthsLivedWithYou).toEqual({ type: 'integer', minimum: 0, maximum: 12 });
    expect(props('add_dependent').dateOfBirth).toEqual({ type: 'string', pattern: String.raw`^\d{4}-\d{2}-\d{2}$` });
    expect(props('add_dependent').relationship).toMatchObject({ type: 'string', enum: expect.arrayContaining(['Daughter', 'None (not related)']) });
    expect(props('add_estimated_payment').jurisdiction).toMatchObject({ enum: expect.arrayContaining(['federal', 'CA']) });
    expect(props('add_estimated_payment').installment).toEqual({ type: 'integer', minimum: 1, maximum: 4 });
    expect(props('add_schedule_c_income').amount).toEqual({ type: 'number', minimum: 0 });
    expect(props('set_state_residency').residencyType).toEqual({ type: 'string', enum: ['resident', 'part_year', 'nonresident'] });
  });

  it('gives the return tools no arguments', () => {
    for (const name of RETURN_TOOL_NAMES) {
      expect(defs.find((d) => d.name === name)!.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    }
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
