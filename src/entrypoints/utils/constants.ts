export const GESTURES = {
  TwoFinger: 'TwoFinger',
  ThreeFinger: 'ThreeFinger',
  FourFinger: 'FourFinger',
  DoubleTap: 'DoubleTap',
  TripleTap: 'TripleTap',
} as const;

export type GestureType = (typeof GESTURES)[keyof typeof GESTURES];
