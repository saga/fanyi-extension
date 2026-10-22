import { describe, expect, it } from 'vitest';
import { normalizeContextWindowOption } from '../entrypoints/utils/codeBuddyContextWindow';

describe('normalizeContextWindowOption', () => {
  it('accepts numeric-string token tiers and does not infer them from model-list data', () => {
    expect(normalizeContextWindowOption({
      type: 'select', id: 'context_window', name: 'Context window', description: 'Select a tier',
      currentValue: '300000',
      options: [{ value: '300000', name: '300K' }, { value: '1000000', name: '1M' }],
    })?.options).toEqual([{ value: '300000', name: '300K' }, { value: '1000000', name: '1M' }]);
    expect(normalizeContextWindowOption({ id: 'deepseek-v4.1-flash', maxInputTokens: 1_000_000 })).toBeUndefined();
  });

  it('hides one-tier, duplicate, nonnumeric, and invalid-current-value options', () => {
    const base = {
      type: 'select', id: 'context_window', name: 'Context window', description: '', currentValue: '300000',
      options: [{ value: '300000', name: '300K' }, { value: '1000000', name: '1M' }],
    };
    expect(normalizeContextWindowOption({ ...base, options: [base.options[0]] })).toBeUndefined();
    expect(normalizeContextWindowOption({ ...base, options: [{ value: '300000', name: '300K' }, { value: '300000', name: 'duplicate' }] })).toBeUndefined();
    expect(normalizeContextWindowOption({ ...base, options: [{ value: '300K', name: '300K' }, { value: '1000000', name: '1M' }] })).toBeUndefined();
    expect(normalizeContextWindowOption({ ...base, currentValue: '999999' })).toBeUndefined();
  });
});
