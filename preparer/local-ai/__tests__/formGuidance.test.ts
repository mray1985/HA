import { describe, it, expect } from 'vitest';
import { CLASSIFIABLE_FORM_TYPES } from '../src/documentClassifier';
import { FORM_EXTRACTION_SCHEMAS, TOOL_MAPPINGS } from '../src/formSchemas';
import { TOOL_APPLICATION } from '../src/taxTools';
import { FORM_GUIDANCE, formGuidance } from '../src/formGuidance';

describe('form guidance', () => {
  it('says something about every form the classifier can assert', () => {
    // A form with no guidance is a form the preparer is handed with nothing to
    // go on, which is the failure this registry exists to stop.
    for (const formType of CLASSIFIABLE_FORM_TYPES) {
      expect(FORM_GUIDANCE[formType], `no guidance for ${formType}`).toBeDefined();
    }
  });

  it.each(Object.keys(FORM_GUIDANCE))('%s explains itself in every part', (formType) => {
    const g = FORM_GUIDANCE[formType as keyof typeof FORM_GUIDANCE];
    for (const part of ['name', 'what', 'why', 'applies'] as const) {
      expect(g[part], `${formType}.${part}`).toBeTruthy();
      expect(typeof g[part]).toBe('string');
    }
    // Plain language: a sentence, not a stub.
    expect(g.what.length, `${formType}.what is too short to explain the form`).toBeGreaterThan(20);
    expect(g.applies.length, `${formType}.applies is too short`).toBeGreaterThan(20);
    expect(g.why.length, `${formType}.why is too short`).toBeGreaterThan(15);
  });

  it('has no entry for a form the classifier cannot assert', () => {
    // A stale entry is a form described to a preparer that can never arrive.
    for (const formType of Object.keys(FORM_GUIDANCE)) {
      expect(CLASSIFIABLE_FORM_TYPES, `${formType} is not classifiable`).toContain(formType);
    }
  });

  it('tells the preparer what to do for a form nothing places automatically', () => {
    // Every classifiable form now has a schema and a tool, so "nothing places it"
    // no longer means "no schema": it means the tool records the form without
    // writing an amount to the return. Those forms must still say what a person
    // has to do, which is the whole point of the guidance.
    const recordedOnly = CLASSIFIABLE_FORM_TYPES.filter((formType) => {
      const tool = TOOL_MAPPINGS[formType]?.tool;
      return !!tool && TOOL_APPLICATION[tool]?.kind === 'candidate_fact';
    });
    expect(recordedOnly.length).toBeGreaterThan(0);
    for (const formType of recordedOnly) {
      expect(FORM_GUIDANCE[formType].byHand, `${formType} says nothing about manual entry`).toBeTruthy();
    }
    // A form the app cannot read at all is still described.
    const schemaless = CLASSIFIABLE_FORM_TYPES.filter((f) => !FORM_EXTRACTION_SCHEMAS[f]);
    for (const formType of schemaless) {
      expect(FORM_GUIDANCE[formType].byHand, `${formType} says nothing about manual entry`).toBeTruthy();
    }
  });

  it('always answers, so the UI never has to guard against a missing form', () => {
    expect(formGuidance(null).applies).toBeTruthy();
    expect(formGuidance(undefined).name).toBe('Unknown document');
    // An unrecognised type keeps its own name so the preparer still sees it.
    expect(formGuidance('1099-ZZ').name).toBe('1099-ZZ');
    expect(formGuidance('1099-ZZ').byHand).toBeTruthy();
  });

  it('describes the form by what it is, not by its box numbers', () => {
    // The printed box numbers live in the schema and are listed per document;
    // repeating them here would drift the moment a revision changed.
    for (const formType of CLASSIFIABLE_FORM_TYPES) {
      expect(FORM_GUIDANCE[formType].name, `${formType}.name`).not.toMatch(/\bBox \d/);
    }
  });
});
