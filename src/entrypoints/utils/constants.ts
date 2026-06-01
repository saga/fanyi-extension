export const GESTURES = {
  ThreeFinger: 'ThreeFinger',
  FourFinger: 'FourFinger',
  DoubleTap: 'DoubleTap',
  TripleTap: 'TripleTap',
} as const;

export type GestureType = (typeof GESTURES)[keyof typeof GESTURES];
