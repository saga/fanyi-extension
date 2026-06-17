export const GESTURES = {
  TripleTap: 'TripleTap',
} as const;

export type GestureType = (typeof GESTURES)[keyof typeof GESTURES];
