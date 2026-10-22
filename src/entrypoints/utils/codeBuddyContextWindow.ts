export interface CodeBuddyContextWindowOption {
  type: 'select';
  id: 'context_window';
  name: string;
  description: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

/** Validate the config-options response. Model-list metadata must never be used to infer tiers. */
export function normalizeContextWindowOption(input: unknown): CodeBuddyContextWindowOption | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const option = input as Partial<CodeBuddyContextWindowOption>;
  if (option.type !== 'select' || option.id !== 'context_window' || !Array.isArray(option.options)) return undefined;
  const values = new Set<string>();
  const options: Array<{ value: string; name: string }> = [];
  for (const item of option.options) {
    if (!item || typeof item.value !== 'string' || !/^\\d+$/.test(item.value)
      || !Number.isSafeInteger(Number(item.value)) || Number(item.value) <= 0
      || typeof item.name !== 'string' || !item.name.trim() || values.has(item.value)) return undefined;
    values.add(item.value);
    options.push({ value: item.value, name: item.name });
  }
  if (options.length < 2 || typeof option.currentValue !== 'string' || !values.has(option.currentValue)) return undefined;
  return {
    type: 'select',
    id: 'context_window',
    name: typeof option.name === 'string' ? option.name : 'Context window',
    description: typeof option.description === 'string' ? option.description : '',
    currentValue: option.currentValue,
    options,
  };
}
