export interface Vec2 {
  x: number;
  y: number;
}

export type PawMode = 'idle' | 'curled' | 'poke' | 'mouse';

export interface PawState {
  side: 'left' | 'right';
  mode: PawMode;
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  pokeTime: number;
  impact: number;
  lastActiveAt: number;
  squash: number;
  curl: number;
  crease: number;
  exposure: number;
  restingLineOpacity: number;
}

export function createPaw(side: PawState['side'], resting: Vec2): PawState {
  return {
    side, mode: 'idle', pos: { ...resting }, vel: { x: 0, y: 0 }, target: { ...resting },
    pokeTime: 0, impact: 0, lastActiveAt: -10000, squash: 0, curl: 0.7, crease: 0, exposure: 0, restingLineOpacity: 1,
  };
}

export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

// Closed-form critical damping retains velocity when input changes the target.
export function spring(
  current: number, velocity: number, target: number, rate: number, dt: number,
): [number, number] {
  const offset = current - target;
  const next = velocity + rate * offset;
  const decay = Math.exp(-rate * dt);
  return [target + (offset + next * dt) * decay, (velocity - rate * next * dt) * decay];
}

const RESPONSE: Record<PawMode, { rate: number; curl: number; crease: number }> = {
  idle: { rate: 17, curl: 0.7, crease: 0 },
  curled: { rate: 21, curl: 1, crease: 0.36 },
  poke: { rate: 38, curl: 0.12, crease: 1 },
  mouse: { rate: 30, curl: 0.04, crease: 0.08 },
};

export function advancePaw(paw: PawState, tucked: Vec2, dt: number): void {
  const { rate, curl, crease } = RESPONSE[paw.mode];
  [paw.pos.x, paw.vel.x] = spring(paw.pos.x, paw.vel.x, paw.target.x, rate, dt);
  [paw.pos.y, paw.vel.y] = spring(paw.pos.y, paw.vel.y, paw.target.y, rate, dt);
  paw.impact = damp(paw.impact, 0, 20, dt);
  paw.squash = damp(paw.squash, paw.impact, 48, dt);
  paw.curl = damp(paw.curl, curl, 20, dt);
  paw.crease = damp(paw.crease, crease, 18, dt);

  // The hand becomes hidden only once it has actually travelled inside the body's silhouette.
  const distance = Math.hypot(paw.pos.x - tucked.x, paw.pos.y - tucked.y);
  const reveal = Math.max(0, Math.min(1, (distance - 4) / 34));
  paw.exposure = reveal * reveal * (3 - 2 * reveal);

  // Only this paw's return can reveal its own resting lines. The fade starts
  // close to the tucked pose, after the moving contour is behind the torso.
  const rest = Math.max(0, Math.min(1, (20 - distance) / 15));
  const resting = paw.mode === 'idle';
  const lineTarget = resting ? rest * rest * (3 - 2 * rest) : 0;
  paw.restingLineOpacity = damp(paw.restingLineOpacity, lineTarget, resting ? 15 : 26, dt);
}
