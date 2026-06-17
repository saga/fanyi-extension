import { describe, it, expect } from 'vitest';
import { GESTURES } from '../entrypoints/utils/constants';
import type { GestureType } from '../entrypoints/utils/constants';

describe('constants', () => {
  describe('GESTURES', () => {
    it('only contains TripleTap', () => {
      expect(GESTURES).toEqual({
        TripleTap: 'TripleTap',
      });
    });

    it('has matching key-value pair', () => {
      expect(GESTURES.TripleTap).toBe('TripleTap');
    });
  });

  describe('GestureType', () => {
    it('allows valid gesture values', () => {
      // Type-level test: ensure GESTURES values are assignable to GestureType
      const gestures: GestureType[] = [GESTURES.TripleTap];
      expect(gestures).toHaveLength(1);
    });
  });
});
