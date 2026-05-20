export function getCenterPoint(touches: TouchList, count: number): { x: number; y: number } | null {
  if (touches.length !== count) return null;

  let centerX = 0;
  let centerY = 0;
  for (let i = 0; i < touches.length; i++) {
    centerX += touches[i].clientX;
    centerY += touches[i].clientY;
  }
  centerX /= touches.length;
  centerY /= touches.length;

  return { x: centerX, y: centerY };
}
