import { damp, type Vec2 } from './pawMotion';

const TAIL_KEYS = new Set([0x20, 0x0d, 0x26, 0x28, 0x25, 0x27, 0x1b, 0x21, 0x22, 0x2e, 0x2d]);

export function isTailKey(vk: number): boolean {
  return TAIL_KEYS.has(vk);
}

export interface TailKeyTarget {
  id: string;
  label: string;
  point: Vec2;
}

interface TailTravel {
  from: Vec2;
  velocity: Vec2;
  to: Vec2;
  duration: number;
  lift: number;
  elapsed: number;
  kind: 'strike' | 'hover' | 'return';
}

export class TailStrike {
  public tip: Vec2 | null = null;
  public reach = 0;
  private velocity = { x: 0, y: 0 };
  private travel: TailTravel | null = null;
  private activeKey: TailKeyTarget | null = null;
  private pendingKey: TailKeyTarget | null = null;
  private restTime = 0;
  private contactTime = 0;

  request(key: TailKeyTarget, rest: Vec2): void {
    if (this.travel?.kind === 'strike' || this.contactTime > 0) {
      // Coalesce bursts to the latest request so the tail never builds up delayed strikes.
      this.pendingKey = key;
      return;
    }
    this.startStrike(key, rest);
  }

  cancel(rest: Vec2): void {
    this.activeKey = null;
    this.pendingKey = null;
    this.contactTime = 0;
    this.restTime = 0;
    if (this.tip && this.travel?.kind !== 'return') this.moveTo(rest, 0.32, 5, 'return');
  }

  private startStrike(key: TailKeyTarget, rest: Vec2): void {
    this.tip ??= { ...rest };
    const distance = Math.hypot(this.tip.x - key.point.x, this.tip.y - key.point.y);
    const duration = Math.min(0.19, 0.08 + distance * 0.00058);
    const lift = Math.min(29, 5 + distance * 0.15);
    this.activeKey = key;
    this.restTime = 0;
    this.moveTo(key.point, duration, lift, 'strike');
  }

  private moveTo(to: Vec2, duration: number, lift: number, kind: TailTravel['kind']): void {
    if (!this.tip) return;
    this.travel = { from: { ...this.tip }, velocity: { ...this.velocity }, to, duration, lift, kind, elapsed: 0 };
  }

  update(dt: number, rest: Vec2): TailKeyTarget | null {
    this.reach = damp(this.reach, this.tip && this.travel?.kind !== 'return' ? 1 : 0, 16, dt);
    const tip = this.tip;
    if (!tip) return null;

    if (this.travel) {
      const motion = this.travel;
      if (motion.kind === 'return') motion.to = rest;
      motion.elapsed += dt;
      const t = Math.min(1, motion.elapsed / motion.duration);
      const remaining = 1 - t;
      const eased = t * t * t * (10 + t * (6 * t - 15));
      const easedSpeed = 30 * t * t * remaining * remaining / motion.duration;
      const carry = t * remaining ** 3 * motion.duration;
      const carrySpeed = remaining * remaining * (1 - 4 * t);
      const lift = 16 * t * t * remaining * remaining * motion.lift;
      const liftSpeed = 32 * t * remaining * (1 - 2 * t) * motion.lift / motion.duration;
      const dx = motion.to.x - motion.from.x;
      const dy = motion.to.y - motion.from.y;
      tip.x = motion.from.x + dx * eased + motion.velocity.x * carry;
      tip.y = motion.from.y + dy * eased + motion.velocity.y * carry - lift;
      this.velocity.x = dx * easedSpeed + motion.velocity.x * carrySpeed;
      this.velocity.y = dy * easedSpeed + motion.velocity.y * carrySpeed - liftSpeed;
      if (t < 1) return null;

      this.travel = null;
      if (motion.kind === 'return') {
        this.tip = null;
        return null;
      }
      if (motion.kind === 'strike') {
        this.contactTime = 0.065;
        return this.activeKey;
      }
      this.restTime = 0.14;
    } else if (this.contactTime > 0) {
      this.contactTime = Math.max(0, this.contactTime - dt);
      if (this.contactTime > 0) return null;
      if (this.pendingKey) {
        const key = this.pendingKey;
        this.pendingKey = null;
        this.startStrike(key, rest);
      } else {
        this.moveTo({ x: tip.x, y: tip.y - 13 }, 0.095, 0, 'hover');
      }
    } else {
      this.restTime -= dt;
      if (this.restTime <= 0) {
        this.activeKey = null;
        this.moveTo(rest, 0.32, 6, 'return');
      }
    }
    return null;
  }
}
