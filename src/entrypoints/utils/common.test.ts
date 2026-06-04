import { describe, it, expect } from 'vitest';
import { getCenterPoint } from './common';

function createTouchList(touches: Array<{ clientX: number; clientY: number }>): TouchList {
  return touches.map(t => ({
    clientX: t.clientX,
    clientY: t.clientY,
    identifier: 0,
    target: null as any,
    screenX: 0,
    screenY: 0,
    pageX: 0,
    pageY: 0,
    radiusX: 0,
    radiusY: 0,
    rotationAngle: 0,
    force: 0,
  })) as unknown as TouchList;
}

describe('getCenterPoint', () => {
  it('returns null when touch count does not match expected count', () => {
    const touches = createTouchList([{ clientX: 100, clientY: 200 }]);
    expect(getCenterPoint(touches, 2)).toBeNull();
  });

  it('returns null when touches length exceeds expected count', () => {
    const touches = createTouchList([
      { clientX: 100, clientY: 200 },
      { clientX: 300, clientY: 400 },
    ]);
    expect(getCenterPoint(touches, 1)).toBeNull();
  });

  it('calculates center of a single touch', () => {
    const touches = createTouchList([{ clientX: 100, clientY: 200 }]);
    const result = getCenterPoint(touches, 1);
    expect(result).toEqual({ x: 100, y: 200 });
  });

  it('calculates center of two touches', () => {
    const touches = createTouchList([
      { clientX: 100, clientY: 200 },
      { clientX: 300, clientY: 400 },
    ]);
    const result = getCenterPoint(touches, 2);
    expect(result).toEqual({ x: 200, y: 300 });
  });

  it('calculates center of three touches', () => {
    const touches = createTouchList([
      { clientX: 0, clientY: 0 },
      { clientX: 300, clientY: 0 },
      { clientX: 0, clientY: 300 },
    ]);
    const result = getCenterPoint(touches, 3);
    expect(result).toEqual({ x: 100, y: 100 });
  });

  it('handles negative coordinates', () => {
    const touches = createTouchList([
      { clientX: -100, clientY: -200 },
      { clientX: -300, clientY: -400 },
    ]);
    const result = getCenterPoint(touches, 2);
    expect(result).toEqual({ x: -200, y: -300 });
  });

  it('handles zero coordinates', () => {
    const touches = createTouchList([
      { clientX: 0, clientY: 0 },
      { clientX: 0, clientY: 0 },
    ]);
    const result = getCenterPoint(touches, 2);
    expect(result).toEqual({ x: 0, y: 0 });
  });
});