import { describe, it, expect } from 'vitest';

import {
  findNoOpBlockIds,
  isAllLongBlocksNoOp,
  isUnchangedTranslation,
} from '../entrypoints/utils/translateApi';

const LONG_EN = 'Lieutenant Grey was glad that at last he had spoken aloud.';
const LONG_ZH = '格雷中尉很高兴，他终于把一直憋在心里的话说了出来。';

describe('空转（no-op）判定', () => {
  it('长段原文返回判空转，短段不判', () => {
    expect(isUnchangedTranslation(LONG_EN, LONG_EN)).toBe(true);
    expect(isUnchangedTranslation(LONG_ZH, LONG_EN)).toBe(false);
    // 短文本原文返回可能是合法的（术语保留），不能判空转。
    expect(isUnchangedTranslation('King Rat', 'King Rat')).toBe(false);
    expect(isUnchangedTranslation('12345', '12345')).toBe(false);
  });

  it('首尾空白差异不算翻译', () => {
    expect(isUnchangedTranslation('  ' + LONG_EN + '\n', LONG_EN)).toBe(true);
  });

  it('findNoOpBlockIds 只挑出长段空转', () => {
    const translations = new Map([
      ['a', LONG_EN],
      ['b', LONG_ZH],
      ['c', 'King Rat'],
    ]);
    const originals = new Map([
      ['a', LONG_EN],
      ['b', LONG_EN],
      ['c', 'King Rat'],
    ]);
    expect(findNoOpBlockIds(translations, originals)).toEqual(['a']);
  });

  it('整批长段全部空转才判整批空转', () => {
    const originals = [
      { id: 'a', text: LONG_EN },
      { id: 'b', text: 'Sergeant Masters had been thinking about a bottle of ice-cold beer.' },
    ];
    const allNoOp = new Map([['a', LONG_EN], ['b', originals[1]!.text]]);
    expect(isAllLongBlocksNoOp(allNoOp, originals, ['a', 'b'])).toBe(true);

    const oneTranslated = new Map([['a', LONG_ZH], ['b', originals[1]!.text]]);
    expect(isAllLongBlocksNoOp(oneTranslated, originals, ['a', 'b'])).toBe(false);

    // 全是短段时无法判定，不误杀术语/编号批次。
    const shorts = new Map([['c', 'King Rat']]);
    expect(isAllLongBlocksNoOp(shorts, [{ id: 'c', text: 'King Rat' }], ['c'])).toBe(false);

    // 长段缺失不算空转（那是缺译，另一条链路处理）。
    const missing = new Map([['a', LONG_EN]]);
    expect(isAllLongBlocksNoOp(missing, originals, ['a', 'b'])).toBe(false);
  });
});
