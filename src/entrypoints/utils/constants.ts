export const GESTURES = {
  ThreeFinger: 'ThreeFinger',
  FourFinger: 'FourFinger',
  TripleTap: 'TripleTap',
} as const;

export type GestureType = (typeof GESTURES)[keyof typeof GESTURES];
