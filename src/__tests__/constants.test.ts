import { describe, it, expect } from 'vitest';
import { GESTURES } from '../entrypoints/utils/constants';
import type { GestureType } from '../entrypoints/utils/constants';

describe('constants', () => {
  describe('GESTURES', () => {
    it('contains all gesture types', () => {
      expect(GESTURES).toEqual({
        ThreeFinger: 'ThreeFinger',
        FourFinger: 'FourFinger',
        TripleTap: 'TripleTap',
      });
    });

    it('has matching key-value pairs', () => {
      expect(GESTURES.ThreeFinger).toBe('ThreeFinger');
      expect(GESTURES.FourFinger).toBe('FourFinger');
      expect(GESTURES.TripleTap).toBe('TripleTap');
    });
  });

  describe('GestureType', () => {
    it('allows valid gesture values', () => {
      // Type-level test: ensure GESTURES values are assignable to GestureType
      const gestures: GestureType[] = [
        GESTURES.ThreeFinger,
        GESTURES.FourFinger,
        GESTURES.TripleTap,
      ];
      expect(gestures).toHaveLength(3);
    });
  });
});