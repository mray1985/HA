import { describe, it, expect } from 'vitest';
import { toolFieldLabel } from '../src/preparerChoices';
import { TOOL_MAPPINGS, FORM_EXTRACTION_SCHEMAS } from '../src/formSchemas';

type Mapping = { tool: string | null; direct?: Record<string, string>; checkboxes?: Record<string, string> };
type Schema = { boxes: ReadonlyArray<{ key: string; box: string }> };

/** The box the form schema prints for a tool field. */
function schemaBox(tool: string, field: string): string | null {
  const mappings = TOOL_MAPPINGS as Record<string, Mapping | undefined>;
  const schemas = FORM_EXTRACTION_SCHEMAS as Record<string, Schema | undefined>;
  for (const [formType, m] of Object.entries(mappings)) {
    if (!m || m.tool !== tool) continue;
    const schema = schemas[formType];
    if (!schema) continue;
    const printed = new Map(schema.boxes.map((b) => [b.key, b.box]));
    for (const g of [m.direct, m.checkboxes]) {
      for (const [k, f] of Object.entries(g ?? {})) if (f === field) return printed.get(k) || null;
    }
  }
  return null;
}

describe('a preparer is sent to a box the form actually has', () => {
  it('names 1099-INT tax-exempt interest as box 8, the box the form prints', () => {
    expect(schemaBox('add_1099_int', 'taxExemptInterest')).toBe('8');
    expect(toolFieldLabel('add_1099_int', 'taxExemptInterest')).toContain('(box 8)');
  });

  it('names 1099-R gross distribution as box 1', () => {
    expect(schemaBox('add_1099_r', 'grossDistribution')).toBe('1');
    expect(toolFieldLabel('add_1099_r', 'grossDistribution')).toContain('(box 1)');
  });

  it('names 1099-R distribution code as box 7a', () => {
    expect(schemaBox('add_1099_r', 'distributionCode')).toBe('7a');
    expect(toolFieldLabel('add_1099_r', 'distributionCode')).toContain('(box 7a)');
  });

  it('names 1098-T scholarships and grants as box 5', () => {
    expect(schemaBox('add_education_expense', 'scholarships')).toBe('5');
    expect(toolFieldLabel('add_education_expense', 'scholarships')).toContain('(box 5)');
  });

  it('agrees with the schema for every mapped field it labels', () => {
    const mappings = TOOL_MAPPINGS as Record<string, Mapping | undefined>;
    const mismatches: string[] = [];
    for (const [formType, m] of Object.entries(mappings)) {
      if (!m?.tool) continue;
      for (const g of [m.direct, m.checkboxes]) {
        for (const [boxKey, field] of Object.entries(g ?? {})) {
          const schema = (FORM_EXTRACTION_SCHEMAS as Record<string, Schema | undefined>)[formType];
          const printed = schema?.boxes.find((b) => b.key === boxKey)?.box;
          if (!printed) continue;
          const label = toolFieldLabel(m.tool as never, field);
          const named = /\(box ([^)]*)\)/.exec(label)?.[1];
          // Only compare where a label names a box at all.
          if (named !== undefined && named !== printed) {
            mismatches.push(`${formType} ${field}: label says box ${named}, form prints box ${printed}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});