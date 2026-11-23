import {
  KEYBOARD_KEYS_65,
  KEYBOARD_KEYS_108,
  getKeyboardLayout,
  type KeySpec,
  type KeyboardLayoutId,
  formatBubbleForVk,
  resolveKeyByVk,
} from './keyboardLayout';
import { catAudio } from './audio';
import { resolveCustomSkin, type CatSkinConfig, type ResolvedSkin } from './catSkins';
import { DaFeiYuRenderer, type DaFeiYuLayout } from './dafeiyuRenderer';
import {
  DESK_KEYBOARD_WIDTH, DESK_KEYBOARD_DEPTH, DESK_TRACKPAD_SLOT_WIDTH, DESK_TRACKPAD_WIDTH, DESK_TRACKPAD_DEPTH,
  DESK_DEVICE_GAP, DESK_CENTER_Y, DESK_KEYS_SIDE_INSET, DESK_KEYS_TOP_INSET, DESK_KEYS_BOTTOM_INSET,
  LOW_PROFILE_LAYOUT, projectDeskPoint, resolveLowProfileKey, traceDeskRect,
} from './deskLayout';
import { advancePaw, createPaw, damp, spring, type PawState, type Vec2 } from './pawMotion';
import { isTailKey, TailStrike } from './tailStrike';

export const LOGICAL_W = 420;
export const LOGICAL_H = 440;
const TRACKPAD_GLIDE_IDLE_MS = 170;
const TRACKPAD_PAW_DWELL_MS = 2200;
const VIEWER_DEVICE_GAP = 10;
const VIEWER_MOUSE_TRAVEL_X = 6;
const VIEWER_MOUSE_TRAVEL_Y = 5;
const TRACKPAD_REAR_HALF_WIDTH = 27;
const TRACKPAD_FRONT_HALF_WIDTH = 29;
const MOUSE_HALF_WIDTH = 18.5;
const TRACKPAD_LEFT_COLOR = '#d4f044';
const TRACKPAD_RIGHT_COLOR = '#ff7b3b';
export type CatBreed = 'black' | 'ragdoll' | 'dafeiyu';
export type KeyboardOrientation = 'cat' | 'viewer';
export type PointerDevice = 'mouse' | 'trackpad';

interface KeyBubble {
  id: number;
  label: string;
  isSpace: boolean;
  x: number;
  targetX: number;
  y: number;
  targetY: number;
  rot: number;
  createdAt: number;
  lifetime: number;
}

interface KeyAnim {
  pressed: boolean;
  pressAmount: number;
  lastHitAt: number;
}

// Exact measured pixel silhouette half-width profile from original video 0.3s (compact chubby sitting cat!)
// t = 0.0 (ear tips) -> t = 1.0 (bottom base flush on keyboard)
const BODY_SLICES: Array<{ t: number; hw: number }> = [
  { t: 0.12, hw: 49 }, // forehead / ear base
  { t: 0.21, hw: 56 }, // eye line
  { t: 0.30, hw: 60 }, // chubby cheeks widest
  { t: 0.38, hw: 52 }, // gentle neck indent
  { t: 0.47, hw: 54 }, // upper chest
  { t: 0.57, hw: 62 }, // mid chest
  { t: 0.68, hw: 70 }, // plump belly
  { t: 0.79, hw: 73 }, // widest soft thighs!
  { t: 0.90, hw: 69 }, // lower thigh curve
  { t: 0.97, hw: 58 }, // tapers softly inward at base!
  { t: 1.00, hw: 46 }, // cozy bottom rest
];

export class KuroCatEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private lastTime = 0;
  private elapsed = 0;

  public showKeyBubbles = true;
  public privacyMode = false;
  public catBreed: CatBreed = 'black';
  public customSkin: ResolvedSkin | null = null;
  public keyboardLayout: KeyboardLayoutId = '65';
  public keyboardOrientation: KeyboardOrientation = 'cat';
  private renderScale = 1.0;
  private embedded = false;
  private dafeiyu = new DaFeiYuRenderer();
  private readonly tailStrike = new TailStrike();
  private privacyClose = 0;
  private privacyTypingAt = -10000;
  private lastMouseNX = 0.5;
  private lastMouseNY = 0.5;
  private lastDt = 1 / 60;

  public setPrivacyMode(active: boolean): void {
    this.privacyMode = active;
    this.dafeiyu.onPrivacyModeChanged(active);
    if (active) {
      this.tailStrike.cancel(this.tailRestTip());
      this.bubbles.length = 0;
      for (const anim of this.keyAnims.values()) {
        anim.pressed = false;
        anim.pressAmount = 0;
      }
    }
  }

  public onPrivacyTyping(): void {
    this.privacyTypingAt = performance.now();
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.onPrivacyTyping();
    }
  }

  public setRenderScale(scale: number): void {
    this.renderScale = Math.max(0.2, Math.min(1.5, scale));
  }

  public getLogicalSize(): { w: number; h: number } {
    return { w: this.logicalW, h: this.logicalH };
  }

  private syncLayoutPositions(): void {
    const isBigFish = this.catBreed === 'dafeiyu';
    if (this.keyboardLayout === '108') {
      this.logicalW = 540;
      this.logicalH = 456;
      this.catCenterX = 278;
      this.catTopY = 66;
      this.catBaseY = 292;
      this.kbCenterX = 290;
      this.kbCenterY = 356;
      this.kbWidth = 398;
      this.kbHeight = 96;
      this.kbTiltRad = (2.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 54 : 46;
      this.mouseBaseY = isBigFish ? 332 : 342;
    } else {
      this.logicalW = 420;
      this.logicalH = 440;
      this.catCenterX = 196;
      this.catTopY = 82;
      this.catBaseY = 308;
      this.kbCenterX = isBigFish ? 234 : 214;
      this.kbCenterY = 353;
      this.kbWidth = 266;
      this.kbHeight = 74;
      this.kbTiltRad = (3.4 * Math.PI) / 180;
      this.mouseBaseX = isBigFish ? 72 : 46;
      this.mouseBaseY = isBigFish ? 322 : 338;
    }

    if (this.usesLowProfileDesk) {
      this.layoutLowProfileDesk();
    } else if (this.keyboardOrientation === 'viewer') {
      this.kbCenterX = this.logicalW - this.kbCenterX;
      const clearance = this.pointerDevice === 'trackpad'
        ? TRACKPAD_FRONT_HALF_WIDTH
        : MOUSE_HALF_WIDTH + VIEWER_MOUSE_TRAVEL_X;
      const alongKeyboard = this.kbWidth * 0.5 + VIEWER_DEVICE_GAP + clearance;
      this.mouseBaseX = this.kbCenterX + alongKeyboard * Math.cos(this.kbTiltRad);
      this.mouseBaseY = this.kbCenterY + alongKeyboard * Math.sin(this.kbTiltRad);
    }

    if (this.leftPaw && this.rightPaw) {
      for (const paw of [this.leftPaw, this.rightPaw]) {
        if (paw.mode !== 'idle' || paw.exposure > 0) continue;
        paw.pos = this.tuckedPawPosition(paw.side);
        paw.target = { ...paw.pos };
        paw.vel = { x: 0, y: 0 };
      }
    }
  }

  private layoutLowProfileDesk(): void {
    const direction = this.keyboardOrientation === 'viewer' ? 1 : -1;
    const trackpad = this.pointerDevice === 'trackpad';
    const deviceSlotWidth = trackpad ? DESK_TRACKPAD_SLOT_WIDTH : (MOUSE_HALF_WIDTH + VIEWER_MOUSE_TRAVEL_X) * 2;
    const deviceWidth = trackpad ? DESK_TRACKPAD_WIDTH : deviceSlotWidth;
    this.kbWidth = DESK_KEYBOARD_WIDTH;
    this.kbHeight = DESK_KEYBOARD_DEPTH;
    this.kbCenterY = DESK_CENTER_Y;
    this.kbTiltRad = 0;
    this.kbCenterX = this.logicalW / 2 - direction * (DESK_DEVICE_GAP + deviceSlotWidth) / 2;
    const catOffset = trackpad && direction === 1 ? 28 : 12;
    this.catCenterX = this.kbCenterX + direction * catOffset;
    this.mouseBaseX = this.kbCenterX + direction * (this.kbWidth / 2 + DESK_DEVICE_GAP + deviceWidth / 2);
    const deviceDepth = trackpad ? DESK_TRACKPAD_DEPTH : 48;
    this.mouseBaseY = this.kbCenterY + (this.kbHeight - deviceDepth) / 2;
  }

  private get usesLowProfileDesk(): boolean {
    return this.personalDesk && this.keyboardLayout === '65';
  }

  private get currentLayout() {
    return this.usesLowProfileDesk ? LOW_PROFILE_LAYOUT : getKeyboardLayout(this.keyboardLayout);
  }

  private resolveKey(vk: number): KeySpec | null {
    return this.usesLowProfileDesk ? resolveLowProfileKey(vk) : resolveKeyByVk(vk, this.keyboardLayout);
  }

  private projectDesk(x: number, y: number): Vec2 {
    return projectDeskPoint(x, y, this.logicalW / 2);
  }

  private getTrackpadContactWorld(): Vec2 {
    const contact = this.getTrackpadContact();
    const x = this.mouseBaseX + contact.x;
    const y = this.mouseBaseY + contact.y;
    return this.usesLowProfileDesk ? this.projectDesk(x, y) : { x, y };
  }

  public setCatAppearance(breedId: string, skin?: CatSkinConfig | null): void {
    if (breedId === 'dafeiyu') {
      this.catBreed = 'dafeiyu';
      this.customSkin = null;
    } else if ((breedId === 'black' || breedId === 'ragdoll') && (!skin || skin.builtin)) {
      this.catBreed = breedId;
      this.customSkin = null;
    } else if (skin) {
      this.catBreed = 'black';
      this.customSkin = resolveCustomSkin(skin);
    } else {
      this.catBreed = 'black';
      this.customSkin = null;
    }
    this.syncLayoutPositions();
    if (!this.isSolidBlackCat) this.tailStrike.cancel(this.tailRestTip());
  }

  public setKeyboardConfig(layout: KeyboardLayoutId, orientation: KeyboardOrientation): void {
    const nextLayout: KeyboardLayoutId = layout === '108' ? '108' : '65';
    const nextOrientation: KeyboardOrientation = orientation === 'viewer' ? 'viewer' : 'cat';
    const layoutChanged = this.keyboardLayout !== nextLayout;
    if (layoutChanged || this.keyboardOrientation !== nextOrientation) {
      this.tailStrike.cancel(this.tailRestTip());
    }
    if (this.keyboardOrientation !== nextOrientation) {
      for (const paw of [this.leftPaw, this.rightPaw]) {
        if (paw.mode === 'mouse') paw.mode = 'idle';
      }
      this.mouseBadges = [];
    }
    this.keyboardLayout = nextLayout;
    this.keyboardOrientation = nextOrientation;

    this.syncLayoutPositions();

    if (layoutChanged) {
      for (const paw of [this.leftPaw, this.rightPaw]) {
        paw.mode = 'idle';
      }
    }
  }

  public setPointerDevice(device: PointerDevice): void {
    if (device === this.pointerDevice) return;
    this.tailStrike.cancel(this.tailRestTip());
    this.pointerDevice = device;
    this.syncLayoutPositions();
    this.mouseBadges = [];
    this.trackpadContact = { x: 0, y: 0 };
    this.trackpadContactTarget = { x: 0, y: 0 };
    if (device === 'mouse' && this.keyboardPaw.mode === 'mouse') {
      this.keyboardPaw.mode = 'idle';
    }
  }

  private get isSolidBlackCat(): boolean {
    return this.catBreed === 'black' && !this.customSkin;
  }

  private get pointerPaw(): PawState {
    return this.keyboardOrientation === 'viewer' ? this.rightPaw : this.leftPaw;
  }

  private get keyboardPaw(): PawState {
    return this.keyboardOrientation === 'viewer' ? this.leftPaw : this.rightPaw;
  }

  private getTrackpadContact(): Vec2 {
    return {
      x: this.trackpadContact.x,
      y: Math.max(-10, Math.min(10, this.trackpadContact.y + this.trackpadScrollOffset)),
    };
  }

  private isTrackpadActive(now: number, idleMs = TRACKPAD_PAW_DWELL_MS): boolean {
    return this.mouseLeftDown || this.mouseRightDown || this.mouseMiddleDown ||
      now - this.lastMouseMoveAt < idleMs;
  }

  private buildDaFeiYuLayout(now: number): DaFeiYuLayout {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const localBtnX = this.mouseLeftDown ? -6.5 : this.mouseRightDown ? 6.5 : 0;
    const localBtnY = -10.5;
    const ang = this.kbTiltRad + (isCatFacing ? Math.PI : 0);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const contact = this.getTrackpadContactWorld();
    return {
      charX: this.usesLowProfileDesk ? this.catCenterX - 4 : this.keyboardLayout === '108' ? 268 : 192,
      logicalW: this.logicalW,
      kbCenterX: this.kbCenterX,
      kbCenterY: this.kbCenterY,
      kbWidth: this.kbWidth,
      kbHeight: this.kbHeight,
      kbTiltRad: this.kbTiltRad,
      mouseBtnX: this.pointerDevice === 'trackpad'
        ? contact.x
        : mx + localBtnX * c - localBtnY * s,
      mouseBtnY: this.pointerDevice === 'trackpad'
        ? contact.y
        : my + localBtnX * s + localBtnY * c,
      mouseNX: this.lastMouseNX,
      pointerOnRight: !isCatFacing,
      mouseLeft: this.mouseLeftDown,
      mouseRight: this.mouseRightDown,
      mouseActive: this.pointerDevice === 'trackpad'
        ? this.isTrackpadActive(now)
        : this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 900,
      petEnergy: this.petEnergy,
      privacyMode: this.privacyMode,
      privacyTypingAt: this.privacyTypingAt,
      is108: this.keyboardLayout === '108',
    };
  }

  // Dynamic logical proportions (65% compact = 420x440; 108-key full-size = 540x456)
  private logicalW = 420;
  private logicalH = 440;
  private catCenterX = 196;
  private catTopY = 82;
  private catBaseY = 308;
  private readonly catHeight = 226;

  // Mechanical keyboard deck below the sitting cat
  private kbCenterX = 214;
  private kbCenterY = 353;
  private kbWidth = 266;
  private kbHeight = 74;
  private kbTiltRad = (3.4 * Math.PI) / 180;

  // Position and animation for the mouse or trackpad
  private pointerDevice: PointerDevice = 'mouse';
  private trackpadContact: Vec2 = { x: 0, y: 0 };
  private trackpadContactTarget: Vec2 = { x: 0, y: 0 };
  private trackpadScrollDirection = 1;
  private trackpadScrollOffset = 0;
  private mouseBaseX = 46;
  private mouseBaseY = 338;
  private mouseOffsetX = 0;
  private mouseOffsetY = 0;
  private mouseTargetOffsetX = 0;
  private mouseTargetOffsetY = 0;
  private mouseLeftDown = false;
  private mouseRightDown = false;
  private mouseMiddleDown = false;
  private mouseLeftPress = 0;
  private mouseRightPress = 0;
  private mouseMiddlePress = 0;
  private mouseScrollFlash = 0;
  private lastMouseMoveAt = -10000;
  private mouseBadges: Array<{
    id: number;
    label: string;
    color: string;
    x: number;
    y: number;
    createdAt: number;
    lifetime: number;
  }> = [];

  // Cursor & 100% live eye tracking + 2.5D head turn
  private cursorRelX = 0.5;
  private cursorRelY = 0.5;
  private cursorOverCat = false;
  private eyeLookX = 0;
  private eyeLookY = 0;
  private faceTurnX = 0;

  // Spine-shear deformation state (exact measured flexible cat spine + playful typing body/head sway!)
  private hindPawLift = 0;
  private spineLean = 0;
  private spineLeanVelocity = 0;
  private headTilt = 0;
  private typingHunch = 0;  // 0..1 lowers head & rounds posture slightly when typing
  private typingSway = 0;   // -1..+1 lively left-right torso & head sway while typing!
  private typingSwayVel = 0;
  private typingGroovePhase = 0;
  private lastKeyBias = 0;
  private strikeRock = 0;
  private strikeRockVel = 0;
  private bodyBob = 0;
  private bodyImpact = 0;
  private kbBounce = 0;

  // Blinking, petting, ear micro-twitch, typing rhythm
  private nextBlinkAt = 2.8;
  private blinkProgress = 0;
  private isBlinking = false;

  private lastPetCursorX: number | null = null;
  private lastPetCursorY: number | null = null;
  private petEnergy = 0;
  private squintAmount = 0;
  private earTwitchLeft = 0;
  private earTwitchRight = 0;
  private recentKeyTimes: number[] = [];
  private typingEnergy = 0;
  private lastAnyKeyAt = -10000;

  // Paws
  private leftPaw: PawState;
  private rightPaw: PawState;
  private lastSpacePaw: 'left' | 'right' = 'left';

  // Keys & bubbles
  private keyAnims = new Map<string, KeyAnim>();
  private bubbles: KeyBubble[] = [];
  private nextBubbleId = 1;

  private readonly personalDesk: boolean;

  constructor(canvas: HTMLCanvasElement, options?: { embedded?: boolean; personalDesk?: boolean }) {
    this.canvas = canvas;
    this.embedded = Boolean(options?.embedded);
    this.personalDesk = Boolean(options?.personalDesk);
    this.syncLayoutPositions();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D canvas context');
    this.ctx = ctx;

    for (const k of this.personalDesk ? LOW_PROFILE_LAYOUT.keys : KEYBOARD_KEYS_65) {
      this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
    }
    for (const k of KEYBOARD_KEYS_108) {
      if (!this.keyAnims.has(k.id)) {
        this.keyAnims.set(k.id, { pressed: false, pressAmount: 0, lastHitAt: -10000 });
      }
    }

    this.leftPaw = createPaw('left', this.tuckedPawPosition('left'));
    this.rightPaw = createPaw('right', this.tuckedPawPosition('right'));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  public resize(): void {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const cssW = Math.max(1, this.embedded ? (this.canvas.clientWidth || 420) : window.innerWidth);
    const cssH = Math.max(1, this.embedded ? (this.canvas.clientHeight || 440) : window.innerHeight);
    const pixelWidth = Math.round(cssW * dpr);
    const pixelHeight = Math.round(cssH * dpr);
    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    if (this.rafId) this.render();
  }

  public start(): void {
    if (this.rafId) return;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.advanceFrame(dt, now);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private advanceFrame(dt: number, now: number): void {
    const steps = Math.ceil(dt * 120);
    const step = dt / steps;
    for (let remaining = steps - 1; remaining >= 0; remaining--) {
      this.update(step, now - remaining * step * 1000);
    }
    this.lastDt = dt;
  }

  public stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // ---- Flexible spine coordinate system (exact match to measured 0.3s -> 2.2s shear!) ----

  private spinePoint(t: number, breath: number): Vec2 {
    // t in [0..1]: 0 = ear tips, 1 = seated base on desk
    const u = Math.max(0, Math.min(1, 1 - t)); // 0 at hips, 1 at head
    const shearCurve = u * u * (3 - 2 * u); // smoothstep from hips up to head!
    // Measured mouse-lean shift (-46px at head) + lively typing left-right body/head sway (+-25px)!
    const leanAmp = this.keyboardLayout === '108' ? 76 : 46;
    const leanX = (this.spineLean * leanAmp + this.typingSway * 25 + this.strikeRock * 10) * shearCurve;
    const swayDipY = Math.abs(this.typingSway) * 4.0 * shearCurve;
    const hunchY = (this.typingHunch * 13 + this.bodyBob * 4.8 + breath) * shearCurve + swayDipY;
    // Slight forward drop when leaning deeply to the mouse
    const leanDropY = Math.abs(this.spineLean) * 6 * shearCurve;
    return {
      x: this.catCenterX + leanX,
      y: this.catTopY + t * this.catHeight + hunchY + leanDropY,
    };
  }

  private getLiveShoulder(paw: PawState, breath: number): Vec2 {
    const sp = this.spinePoint(0.50, breath);
    return {
      x: sp.x + (paw.side === 'left' ? -32 : 32),
      y: sp.y,
    };
  }

  private tuckedPawPosition(side: PawState['side']): Vec2 {
    return { x: this.catCenterX + (side === 'left' ? -20 : 20), y: this.catBaseY - 19 };
  }

  private getLiveCurledPawPos(paw: PawState, breath: number): Vec2 {
    // Bent forearm elbow -> cute curled paw sitting near lower belly (matches 8.3s / 10.6s!)
    const sp = this.spinePoint(0.80, breath);
    const bob = Math.sin(this.elapsed * 12 + (paw.side === 'left' ? 0 : Math.PI)) * (1.5 + this.typingEnergy * 2.0);
    const xOff = paw.side === 'left' ? -24 : 24;
    return {
      x: sp.x + xOff,
      y: sp.y + bob,
    };
  }

  // ---- Input event handlers ----

  public onKeyDown(vk: number, repeat: boolean): void {
    if (this.privacyMode) {
      if (!repeat) this.onPrivacyTyping();
      return;
    }
    const now = performance.now();
    const spec = this.resolveKey(vk);
    if (!spec) return;

    const tailKey = this.personalDesk && this.isSolidBlackCat && isTailKey(vk);
    const anim = this.keyAnims.get(spec.id);
    if (anim && !tailKey) {
      anim.pressed = true;
      anim.pressAmount = 1;
      anim.lastHitAt = now;
    }

    if (repeat) return;

    this.lastAnyKeyAt = now;
    this.recentKeyTimes.push(now);
    if (this.recentKeyTimes.length > 26) this.recentKeyTimes.shift();

    if (tailKey) {
      const point = spec.id === 'space'
        ? this.projectKeyboardPoint(
          spec.uStart + spec.uWidth * (this.keyboardOrientation === 'viewer' ? 0.85 : 0.15),
          (spec.rowY ?? spec.row) + 0.5,
        )
        : this.getKeyWorldCenter(spec);
      point.y -= 8;
      this.tailStrike.request({ id: spec.id, label: formatBubbleForVk(vk, spec), point }, this.tailRestTip());
      return;
    }

    this.bodyImpact = Math.min(1.15, this.bodyImpact + 0.65);
    this.kbBounce = Math.min(1, this.kbBounce + 0.45);

    if (this.catBreed === 'dafeiyu') {
      const pt = this.getKeyWorldCenter(spec);
      this.dafeiyu.onKeyDown(vk, pt, this.buildDaFeiYuLayout(now), repeat);
      if (this.showKeyBubbles) {
        const label = formatBubbleForVk(vk, spec);
        if (label) {
          this.spawnBubble(label, spec.id === 'space', pt.x, now);
        }
      }
      return;
    }

    if (Math.random() < 0.16) {
      if (Math.random() < 0.5) this.earTwitchLeft = 1;
      else this.earTwitchRight = 1;
    }

    const layout = this.currentLayout;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const keyColCenter = spec.uStart + spec.uWidth * 0.5;
    const screenKeyCol = isCatFacing ? layout.totalUnits - keyColCenter : keyColCenter;
    const midCol = layout.totalUnits * 0.5;
    const keyBias = Math.max(-1, Math.min(1, (screenKeyCol - midCol) / (layout.totalUnits * 0.34)));
    this.lastKeyBias = keyBias;


    let targetPoint = this.getKeyWorldCenter(spec);
    let chosen: PawState;

    const activelyMousing = this.pointerDevice === 'trackpad'
      ? this.isTrackpadActive(now, 320)
      : this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 320;
    const splitCol =
      this.keyboardLayout === '108'
        ? isCatFacing
          ? 12.2
          : 8.4
        : 7.5;

    if (spec.id === 'space') {
      if (activelyMousing) {
        chosen = this.keyboardPaw;
      } else {
        this.lastSpacePaw = this.lastSpacePaw === 'left' ? 'right' : 'left';
        chosen = this.lastSpacePaw === 'left' ? this.leftPaw : this.rightPaw;
      }
      const spaceU = isCatFacing
        ? chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.68
          : spec.uStart + spec.uWidth * 0.32
        : chosen.side === 'left'
          ? spec.uStart + spec.uWidth * 0.32
          : spec.uStart + spec.uWidth * 0.68;
      const rY = spec.rowY ?? spec.row;
      targetPoint = this.projectKeyboardPoint(spaceU, rY + 0.50);
    } else if (activelyMousing) {
      chosen = this.keyboardPaw;
    } else if (screenKeyCol < splitCol) {
      chosen = this.leftPaw;
    } else {
      chosen = this.rightPaw;
    }

    const sideSign = chosen.side === 'left' ? -1 : 1;
    this.strikeRockVel += sideSign * (1.75 + this.typingEnergy * 1.25);
    if (!activelyMousing) {
      // Lively groove impulse: rocks head & upper body back and forth as the cat types!
      this.typingSwayVel += (keyBias * 2.1 + Math.cos(this.typingGroovePhase) * 1.65) * (0.9 + this.typingEnergy * 0.45);
    }

    chosen.mode = 'poke';
    chosen.target = this.clampToKeyboardSurface(targetPoint);
    chosen.pokeTime = 0;
    chosen.impact = 0.85;

    const other = chosen.side === 'left' ? this.rightPaw : this.leftPaw;
    if (!this.isSolidBlackCat && other.mode === 'idle' && !activelyMousing) {
      other.mode = 'curled';
    }

    if (this.showKeyBubbles) {
      const label = formatBubbleForVk(vk, spec);
      if (label) {
        this.spawnBubble(label, spec.id === 'space', targetPoint.x, now);
      }
    }
  }

  public onKeyUp(vk: number): void {
    this.dafeiyu.onKeyUp(vk);
    if (this.privacyMode) return;
    const spec = this.resolveKey(vk);
    if (!spec) return;
    const anim = this.keyAnims.get(spec.id);
    if (anim) anim.pressed = false;
  }

  public onGlobalMouseMove(nx: number, ny: number): void {
    const now = performance.now();
    if (this.pointerDevice === 'trackpad') {
      if (nx === this.lastMouseNX && ny === this.lastMouseNY) return;
      if (now - this.lastMouseMoveAt >= TRACKPAD_GLIDE_IDLE_MS) {
        this.trackpadContactTarget.x = this.trackpadContact.x;
        this.trackpadContactTarget.y = this.trackpadContact.y;
      }
      const target = this.trackpadContactTarget;
      target.x = Math.max(-13, Math.min(13, target.x + (nx - this.lastMouseNX) * 190));
      target.y = Math.max(-9, Math.min(9, target.y + (ny - this.lastMouseNY) * 145));
    }
    this.lastMouseNX = nx;
    this.lastMouseNY = ny;
    this.mouseTargetOffsetX = (nx - 0.5) * (this.catBreed === 'dafeiyu' ? 14 : 28);
    this.mouseTargetOffsetY = (ny - 0.5) * (this.catBreed === 'dafeiyu' ? 11 : 20);
    this.lastMouseMoveAt = now;

    if (this.pointerPaw.mode !== 'poke') this.pointerPaw.mode = 'mouse';
  }

  private getMouseButtonColors(): { left: string; right: string; middle: string } {
    const primary = this.customSkin
      ? this.customSkin.accentColor
      : this.catBreed === 'dafeiyu'
        ? '#5cc8ff'
        : this.catBreed === 'ragdoll'
          ? '#7ac7ff'
          : '#d4f044';
    const scroll = this.customSkin
      ? this.customSkin.accentSideColor
      : this.catBreed === 'dafeiyu'
        ? '#2563eb'
        : this.catBreed === 'ragdoll'
          ? '#4690d8'
          : '#92ba12';

    if (this.pointerDevice === 'trackpad') {
      return { left: TRACKPAD_LEFT_COLOR, right: TRACKPAD_RIGHT_COLOR, middle: scroll };
    }

    // Pick a high-contrast complementary color for RMB so Left vs Right click are unmistakable on every skin
    const isWarmAccent = /^#(f[a-f0-9][89a-c]|ff[789a-c]|e[89a-f][789a])/i.test(primary);
    const rightColor = isWarmAccent ? '#58c7ff' : '#ff7b3b';
    return { left: primary, right: rightColor, middle: scroll };
  }

  private spawnMouseBadge(button: 'left' | 'right' | 'middle', now: number): void {
    if (!this.showKeyBubbles) return;
    const colors = this.getMouseButtonColors();
    const label = button === 'left' ? 'LMB' : button === 'right' ? 'RMB' : 'MMB';
    const color = button === 'left' ? colors.left : button === 'right' ? colors.right : colors.middle;
    const trackpad = this.pointerDevice === 'trackpad';
    const anchor = trackpad
      ? this.getTrackpadContactWorld()
      : { x: this.mouseBaseX + this.mouseOffsetX, y: this.mouseBaseY + this.mouseOffsetY };
    const badgeY = trackpad
      ? this.mouseBaseY - (this.usesLowProfileDesk ? DESK_TRACKPAD_DEPTH / 2 + 12 : 29)
      : anchor.y - 30;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const sideShift =
      button === 'left'
        ? isCatFacing
          ? 10
          : -10
        : button === 'right'
          ? isCatFacing
            ? -10
            : 10
          : 0;

    if (this.mouseBadges.length >= 2) {
      this.mouseBadges.shift();
    }
    this.mouseBadges.push({
      id: this.nextBubbleId++,
      label,
      color,
      x: Math.max(24, Math.min(this.logicalW - 24, anchor.x + sideShift)),
      y: badgeY,
      createdAt: now,
      lifetime: 560,
    });
  }

  public onMouseDown(button: string): void {
    const now = performance.now();
    if (button === 'left') {
      this.mouseLeftDown = true;
      this.mouseLeftPress = 1;
      this.spawnMouseBadge('left', now);
    } else if (button === 'right') {
      this.mouseRightDown = true;
      this.mouseRightPress = 1;
      this.spawnMouseBadge('right', now);
      if (this.pointerDevice === 'trackpad' && this.keyboardPaw.mode !== 'poke') {
        this.keyboardPaw.mode = 'mouse';
        this.keyboardPaw.impact = 0.72;
      }
    } else if (button === 'middle') {
      this.mouseMiddleDown = true;
      this.mouseMiddlePress = 1;
      this.spawnMouseBadge('middle', now);
    }

    this.lastMouseMoveAt = now;
    this.dafeiyu.resetPointerHand(this.keyboardOrientation === 'viewer');
    this.pointerPaw.mode = 'mouse';
    this.pointerPaw.impact = 0.72;
  }

  public onMouseUp(button: string): void {
    if (button === 'left') this.mouseLeftDown = false;
    else if (button === 'right') this.mouseRightDown = false;
    else if (button === 'middle') this.mouseMiddleDown = false;
  }

  public onMouseWheel(delta = 0): void {
    const now = performance.now();
    if (delta !== 0) this.trackpadScrollDirection = Math.sign(delta);
    this.mouseScrollFlash = 1;
    this.lastMouseMoveAt = now;
    this.dafeiyu.resetPointerHand(this.keyboardOrientation === 'viewer');
    this.pointerPaw.mode = 'mouse';
  }

  public onWindowCursor(relX: number, relY: number, overCat: boolean): void {
    this.cursorRelX = relX;
    this.cursorRelY = relY;
    this.cursorOverCat = overCat;

    if (overCat && !this.mouseLeftDown && !this.mouseRightDown) {
      const px = relX * this.logicalW;
      const py = relY * this.logicalH;
      if (this.lastPetCursorX !== null && this.lastPetCursorY !== null) {
        const dist = Math.hypot(px - this.lastPetCursorX, py - this.lastPetCursorY);
        if (dist > 1.5 && dist < 80) {
          this.petEnergy = Math.min(1, this.petEnergy + dist * 0.011);
        }
      }
      this.lastPetCursorX = px;
      this.lastPetCursorY = py;
    } else {
      this.lastPetCursorX = null;
      this.lastPetCursorY = null;
    }
  }

  // ---- Keyboard projection ----

  private projectKeyboardPoint(uCol: number, rowPos: number): Vec2 {
    const layout = this.currentLayout;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const screenU = isCatFacing ? layout.totalUnits - uCol : uCol;
    const screenRow = isCatFacing ? layout.totalRows - rowPos : rowPos;

    if (this.usesLowProfileDesk) {
      const bounds = this.lowProfileKeyBounds();
      return this.projectDesk(bounds.left + screenU * bounds.unitWidth, bounds.top + screenRow * bounds.rowHeight);
    }

    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;
    const localX = -innerW / 2 + (screenU / layout.totalUnits) * innerW;
    const localY = -innerH / 2 + (screenRow / layout.totalRows) * innerH;

    const depthFactor = 0.94 + (screenRow / layout.totalRows) * 0.09;
    const px = localX * depthFactor;
    const py = localY;

    const cos = Math.cos(this.kbTiltRad);
    const sin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + px * cos - py * sin,
      y: this.kbCenterY + px * sin + py * cos,
    };
  }

  private getKeyWorldCenter(spec: KeySpec): Vec2 {
    const layout = this.currentLayout;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const uClamped = Math.max(0.65, Math.min(layout.totalUnits - 0.65, spec.uStart + spec.uWidth * 0.5));
    const rY = spec.rowY ?? spec.row;
    const rSpan = spec.rowSpan ?? 1;
    let rowPos = rY + rSpan * 0.5;
    if (isCatFacing && rY <= 0.1) {
      rowPos = rY + 0.68;
    } else if (!isCatFacing && rY + rSpan >= layout.totalRows - 0.1) {
      rowPos = rY + rSpan - 0.68;
    }
    return this.projectKeyboardPoint(uClamped, rowPos);
  }

  private clampToKeyboardSurface(pt: Vec2): Vec2 {
    if (this.usesLowProfileDesk) {
      const top = this.kbCenterY - this.kbHeight / 2;
      const y = Math.max(top + 9, Math.min(top + this.kbHeight - 8, pt.y));
      const left = this.projectDesk(this.kbCenterX - this.kbWidth / 2 + 10, y).x;
      const right = this.projectDesk(this.kbCenterX + this.kbWidth / 2 - 10, y).x;
      return { x: Math.max(left, Math.min(right, pt.x)), y };
    }
    // Transform into keyboard-local space and clamp so the plump paw pad NEVER extends past the keyboard bezel!
    const dx = pt.x - this.kbCenterX;
    const dy = pt.y - this.kbCenterY;
    const cos = Math.cos(-this.kbTiltRad);
    const sin = Math.sin(-this.kbTiltRad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    const maxX = this.kbWidth * 0.5 - 15;
    const minY = -this.kbHeight * 0.5 + 8;
    const maxY = this.kbHeight * 0.5 - 14;
    const cx = Math.max(-maxX, Math.min(maxX, lx));
    const cy = Math.max(minY, Math.min(maxY, ly));

    const rcos = Math.cos(this.kbTiltRad);
    const rsin = Math.sin(this.kbTiltRad);
    return {
      x: this.kbCenterX + cx * rcos - cy * rsin,
      y: this.kbCenterY + cx * rsin + cy * rcos,
    };
  }

  private spawnBubble(label: string, isSpace: boolean, keyX: number, now: number): void {
    if (this.bubbles.length >= 6) {
      this.bubbles.shift();
    }
    const minX = this.keyboardLayout === '108' ? 145 : 125;
    const maxX = this.logicalW - 105;
    const baseX = Math.max(minX, Math.min(maxX, keyX * 0.45 + this.kbCenterX * 0.55));
    const staggerY = 258 + ((this.nextBubbleId % 3) - 1) * 10 + (Math.random() - 0.5) * 6;
    this.bubbles.push({
      id: this.nextBubbleId++,
      label,
      isSpace,
      x: baseX,
      targetX: baseX,
      y: 292,
      targetY: staggerY,
      rot: ((Math.random() - 0.5) * 4.5 * Math.PI) / 180,
      createdAt: now,
      lifetime: 940,
    });
    this.layoutBubbles();
  }

  private layoutBubbles(): void {
    const count = this.bubbles.length;
    if (count === 0) return;

    const widths = this.bubbles.map((b) => (b.isSpace ? 40 : Math.max(25, b.label.length * 7.5 + 14)));
    const gap = 3.5;
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (count - 1);
    const anchor = this.kbCenterX + 12;
    const leftBound = this.keyboardLayout === '108' ? 140 : 126;
    const rightBound = this.logicalW - 82;
    let cursor = Math.max(leftBound, Math.min(rightBound - totalW, anchor - totalW * 0.5));

    for (let i = 0; i < count; i++) {
      const w = widths[i];
      this.bubbles[i].targetX = cursor + w * 0.5;
      cursor += w + gap;
    }
  }

  // ---- Simulation update ----

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    const mLerp = 1 - Math.exp(-28 * dt);
    this.mouseOffsetX += (this.mouseTargetOffsetX - this.mouseOffsetX) * mLerp;
    this.mouseOffsetY += (this.mouseTargetOffsetY - this.mouseOffsetY) * mLerp;
    if (this.keyboardOrientation === 'viewer') {
      this.mouseOffsetX = Math.max(-VIEWER_MOUSE_TRAVEL_X, Math.min(VIEWER_MOUSE_TRAVEL_X, this.mouseOffsetX));
      this.mouseOffsetY = Math.max(-VIEWER_MOUSE_TRAVEL_Y, Math.min(VIEWER_MOUSE_TRAVEL_Y, this.mouseOffsetY));
    }
    if (!this.mouseLeftDown && this.mouseLeftPress > 0) {
      this.mouseLeftPress = Math.max(0, this.mouseLeftPress - dt * 5.8);
    }
    if (!this.mouseRightDown && this.mouseRightPress > 0) {
      this.mouseRightPress = Math.max(0, this.mouseRightPress - dt * 5.8);
    }
    if (!this.mouseMiddleDown && this.mouseMiddlePress > 0) {
      this.mouseMiddlePress = Math.max(0, this.mouseMiddlePress - dt * 5.8);
    }
    if (!this.isTrackpadActive(now, TRACKPAD_GLIDE_IDLE_MS)) {
      this.trackpadContactTarget.x *= Math.exp(-5 * dt);
      this.trackpadContactTarget.y *= Math.exp(-5 * dt);
    }
    this.trackpadContact.x += (this.trackpadContactTarget.x - this.trackpadContact.x) * mLerp;
    this.trackpadContact.y += (this.trackpadContactTarget.y - this.trackpadContact.y) * mLerp;
    const scrollTarget = this.mouseScrollFlash > 0.12 ? this.trackpadScrollDirection * 7 : 0;
    this.trackpadScrollOffset += (scrollTarget - this.trackpadScrollOffset) * (1 - Math.exp(-18 * dt));
    this.mouseScrollFlash = Math.max(0, this.mouseScrollFlash - dt * 4.5);
    this.mouseBadges = this.mouseBadges.filter((b) => now - b.createdAt < b.lifetime);

    while (this.recentKeyTimes.length > 0 && now - this.recentKeyTimes[0] > 950) {
      this.recentKeyTimes.shift();
    }
    const targetTypingEnergy = Math.min(1, this.recentKeyTimes.length / 7);
    this.typingEnergy += (targetTypingEnergy - this.typingEnergy) * (1 - Math.exp(-9 * dt));

    const isTypingRecently = now - this.lastAnyKeyAt < 650;
    const targetHunch = isTypingRecently ? 0.45 + this.typingEnergy * 0.55 : 0;
    this.typingHunch += (targetHunch - this.typingHunch) * (1 - Math.exp(-10 * dt));

    [this.strikeRock, this.strikeRockVel] = spring(this.strikeRock, this.strikeRockVel, 0, 15, dt);
    this.bodyImpact = damp(this.bodyImpact, 0, 21, dt);
    this.bodyBob = damp(this.bodyBob, this.bodyImpact, 32, dt);
    this.kbBounce = Math.max(0, this.kbBounce - dt * 15);

    // Playful left-right body & head groove sway during pure typing (matches original video first half!)
    const usingPointer = this.pointerPaw.mode === 'mouse';
    const pureTypingActive = isTypingRecently && !usingPointer;
    if (pureTypingActive) {
      this.typingGroovePhase += dt * (4.8 + this.typingEnergy * 5.2);
    }
    const grooveWave = Math.sin(this.typingGroovePhase) * (0.58 + this.typingEnergy * 0.44);
    const targetTypingSway = pureTypingActive
      ? Math.max(-1.1, Math.min(1.1, grooveWave * 0.72 + this.lastKeyBias * 0.55))
      : usingPointer && isTypingRecently
        ? Math.sin(this.typingGroovePhase) * 0.16
        : 0;
    [this.typingSway, this.typingSwayVel] = spring(this.typingSway, this.typingSwayVel, targetTypingSway, 13, dt);

    // Lean toward the pointer device while the hips stay anchored.
    let targetLean = 0;
    if (usingPointer) {
      const side = this.keyboardOrientation === 'viewer' ? 1 : -1;
      const reach = this.keyboardPaw.mode === 'poke' ? 0.52 : 0.96;
      targetLean = side * reach + (this.mouseOffsetX / 18) * 0.22;
    }
    [this.spineLean, this.spineLeanVelocity] = spring(this.spineLean, this.spineLeanVelocity, targetLean, 16, dt);

    const desiredHeadTilt =
      this.typingSway * 0.18 +
      this.typingHunch * (this.strikeRock * 0.065 - 0.02) +
      this.spineLean * 0.085;
    this.headTilt += (desiredHeadTilt - this.headTilt) * (1 - Math.exp(-12 * dt));

    this.petEnergy = Math.max(0, this.petEnergy - dt * (this.cursorOverCat ? 0.22 : 0.65));
    const wantSquint = this.petEnergy > 0.3 ? 1 : 0;
    this.squintAmount += (wantSquint - this.squintAmount) * (1 - Math.exp(-12 * dt));
    const wantPrivacy = this.privacyMode ? 1 : 0;
    this.privacyClose += (wantPrivacy - this.privacyClose) * (1 - Math.exp(-14 * dt));
    catAudio.setPurrIntensity(!this.privacyMode && this.squintAmount > 0.25 ? this.squintAmount : 0);
    if (this.catBreed === 'dafeiyu') {
      this.dafeiyu.update(dt, now, this.buildDaFeiYuLayout(now));
    }

    this.earTwitchLeft = Math.max(0, this.earTwitchLeft - dt * 8);
    this.earTwitchRight = Math.max(0, this.earTwitchRight - dt * 8);

    if (!this.isBlinking && this.elapsed >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }
    if (this.isBlinking) {
      this.blinkProgress += dt * 12;
      if (this.blinkProgress >= 2) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.nextBlinkAt = this.elapsed + 2.8 + Math.random() * 3.6;
      }
    }

    // 100% live eye tracking toward cursor, OR cozy bottom-edge glance at keys during pure typing!
    const eyePos = this.spinePoint(0.24, 0);
    const eyeCenterRelX = eyePos.x / this.logicalW;
    const eyeCenterRelY = eyePos.y / this.logicalH;
    let dx = this.cursorRelX - eyeCenterRelX;
    let dy = this.cursorRelY - eyeCenterRelY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) {
      const mag = Math.min(1, dist * 1.9);
      dx = (dx / dist) * mag;
      dy = (dy / dist) * mag;
    }
    const mouseRecentlyMoved = this.pointerDevice === 'trackpad'
      ? this.isTrackpadActive(now)
      : now - this.lastMouseMoveAt < 2400;
    const pureTypingGlance = mouseRecentlyMoved ? 0 : this.typingHunch;
    const targetEyeX =
      dx * 7.0 * (1 - pureTypingGlance * 0.45) +
      pureTypingGlance * (this.typingSway * 3.8 + this.lastKeyBias * 2.2);
    const targetEyeY = dy * 5.2 * (1 - pureTypingGlance * 0.45) + pureTypingGlance * 5.8;
    const eyeLerp = 1 - Math.exp(-20 * dt);
    this.eyeLookX += (targetEyeX - this.eyeLookX) * eyeLerp;
    this.eyeLookY += (targetEyeY - this.eyeLookY) * eyeLerp;

    const targetFaceTurn = dx * 4.0 + this.spineLean * 8.0 + this.typingSway * 8.5 + pureTypingGlance * 1.5;
    this.faceTurnX += (targetFaceTurn - this.faceTurnX) * (1 - Math.exp(-11 * dt));

    for (const anim of this.keyAnims.values()) {
      if (!anim.pressed && anim.pressAmount > 0) {
        anim.pressAmount = Math.max(0, anim.pressAmount - dt * 5.0);
      }
    }

    const landed = this.tailStrike.update(dt, this.tailRestTip());
    if (landed && !this.privacyMode) {
      const key = this.keyAnims.get(landed.id);
      if (key) {
        key.pressAmount = 1;
        key.lastHitAt = now;
      }
      this.kbBounce = Math.min(1, this.kbBounce + 0.28);
      this.bodyImpact = Math.min(1.15, this.bodyImpact + 0.28);
      if (this.showKeyBubbles && landed.label) {
        this.spawnBubble(landed.label, landed.id === 'space', landed.point.x, now);
      }
    }

    this.updatePaw(this.leftPaw, dt, now);
    this.updatePaw(this.rightPaw, dt, now);
    const frontLift = Math.max(this.leftPaw.exposure, this.rightPaw.exposure);
    this.hindPawLift += (frontLift - this.hindPawLift) * (1 - Math.exp(-12 * dt));

    const beforeLen = this.bubbles.length;
    this.bubbles = this.bubbles.filter((b) => now - b.createdAt < b.lifetime);
    if (this.bubbles.length !== beforeLen) {
      this.layoutBubbles();
    }
    for (const b of this.bubbles) {
      const age = (now - b.createdAt) / b.lifetime;
      b.x += (b.targetX - b.x) * (1 - Math.exp(-18 * dt));
      const desiredY = b.targetY - age * 10;
      b.y += (desiredY - b.y) * (1 - Math.exp(-16 * dt));
    }
  }

  private updatePaw(paw: PawState, dt: number, now: number): void {
    const liveMouseX = this.mouseBaseX + this.mouseOffsetX;
    const liveMouseY = this.mouseBaseY + this.mouseOffsetY;

    if (paw.mode === 'mouse') {
      const isCatFacing = this.keyboardOrientation === 'cat';
      const lrBias = this.mouseLeftPress - this.mouseRightPress;
      const anyClickPress = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
      if (this.pointerDevice === 'trackpad') {
        const contact = this.getTrackpadContactWorld();
        const spacing = this.mouseRightPress * 6;
        paw.target = {
          x: contact.x + (paw.side === 'right' ? spacing : -spacing),
          y: contact.y + anyClickPress * 2,
        };
      } else if (isCatFacing) {
        // 180° cat-facing: palm heel at TOP, LMB = inner/+X, RMB = outer/-X
        paw.target = {
          x: liveMouseX + 1.2 + lrBias * 6.4,
          y: liveMouseY - 11.5 + anyClickPress * 3.6,
        };
      } else {
        // 0° viewer-facing: palm heel at BOTTOM, LMB = left/-X, RMB = right/+X
        paw.target = {
          x: liveMouseX + 0.5 - lrBias * 6.4,
          y: liveMouseY + 10.0 - anyClickPress * 3.4,
        };
      }
      const stillHolding = this.pointerDevice === 'trackpad'
        ? (paw === this.keyboardPaw ? this.mouseRightPress >= 0.05 : this.isTrackpadActive(now))
        : this.mouseLeftDown || this.mouseRightDown || this.mouseMiddleDown ||
          now - this.lastMouseMoveAt < 2200;
      if (!stillHolding) {
        paw.mode = 'idle';
      }
    } else if (paw.mode === 'poke') {
      paw.pokeTime += dt;
      if (paw.pokeTime > 0.13) {
        const returnToPointer = this.pointerDevice === 'trackpad'
          ? this.isTrackpadActive(now, 320)
          : this.mouseLeftDown || this.mouseRightDown || now - this.lastMouseMoveAt < 450;
        if (paw === this.pointerPaw && returnToPointer) {
          paw.mode = 'mouse';
        } else if (!this.isSolidBlackCat && now - this.lastAnyKeyAt < 650) {
          paw.mode = 'curled';
        } else {
          paw.mode = 'idle';
        }
      }
    } else if (paw.mode === 'curled') {
      if (now - this.lastAnyKeyAt > 680) {
        paw.mode = 'idle';
      }
    }

    const tucked = this.tuckedPawPosition(paw.side);
    if (paw.mode === 'curled') {
      paw.target = this.getLiveCurledPawPos(paw, 0);
    } else if (paw.mode === 'idle') {
      paw.target = tucked;
    }

    advancePaw(paw, tucked, dt);
  }

  // ---- High-fidelity true-scale rendering ----

  private render(): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    ctx.save();
    if (this.embedded) {
      const baseFit = Math.min((cw * 0.86) / this.logicalW, (ch * 0.86) / this.logicalH);
      const effectiveMul = this.renderScale <= 1.0 ? this.renderScale : 1.0 + (this.renderScale - 1.0) * 0.30;
      const uniformScale = baseFit * effectiveMul;
      const drawW = this.logicalW * uniformScale;
      const drawH = this.logicalH * uniformScale;
      const offsetX = (cw - drawW) * 0.5;
      const offsetY = (ch - drawH) * 0.52;
      ctx.translate(offsetX, offsetY);
      ctx.scale(uniformScale, uniformScale);
    } else {
      const cssW = Math.max(1, window.innerWidth);
      const dpr = cw / cssW;
      const fitScale = Math.min(cw / this.logicalW, ch / this.logicalH);
      const uniformScale = Math.min(fitScale, this.renderScale * dpr);
      const drawW = this.logicalW * uniformScale;
      const drawH = this.logicalH * uniformScale;
      const offsetX = cw - drawW;
      const offsetY = ch - drawH;
      ctx.translate(offsetX, offsetY);
      ctx.scale(uniformScale, uniformScale);
    }

    const breath = Math.sin(this.elapsed * 2.1) * 1.0;
    const purrShift = this.squintAmount > 0.4 ? Math.sin(this.elapsed * 22) * 0.45 * this.squintAmount : 0;

    if (this.catBreed === 'dafeiyu') {
      const now = performance.now();
      const layout = this.buildDaFeiYuLayout(now);
      this.dafeiyu.renderBody(ctx, now, layout);
      this.drawPointerDevice(ctx);
      this.drawKeyboard(ctx);
      this.dafeiyu.renderForeground(ctx, this.lastDt, now, layout);
      if (this.showKeyBubbles && !this.privacyMode) {
        this.drawKeyBubbles(ctx);
        this.drawMouseBadges(ctx);
      }
      ctx.restore();
      return;
    }

    if (!this.isSolidBlackCat) this.drawTail(ctx);
    this.drawPointerDevice(ctx);
    this.drawKeyboard(ctx);
    if (this.isSolidBlackCat) this.drawTail(ctx);

    if (this.isSolidBlackCat) {
      // The solid dark limbs pass behind the torso as they retract.
      this.drawPaw(ctx, this.leftPaw, breath);
      this.drawPaw(ctx, this.rightPaw, breath);
      this.drawCatBody(ctx, breath, purrShift);
    } else {
      this.drawCatBody(ctx, breath, purrShift);
      this.drawPaw(ctx, this.leftPaw, breath);
      this.drawPaw(ctx, this.rightPaw, breath);
    }

    // Layer 5: Organic bouncing 3D keycap bubbles & crisp mouse click badges
    if (this.showKeyBubbles && !this.privacyMode) {
      this.drawKeyBubbles(ctx);
      this.drawMouseBadges(ctx);
    }

    ctx.restore();
  }

  private tailRestTip(): Vec2 {
    const hip = this.spinePoint(0.84, 0);
    const drift = Math.sin(this.elapsed * 0.9) * 1.4;
    return { x: hip.x + 126 + drift * 0.35, y: hip.y - 37 + drift };
  }

  private drawTail(ctx: CanvasRenderingContext2D): void {
    // Exact ORIG 0.3s tail: leaves hip slightly higher, flat horizontal start curving cleanly up into a soft horizontal S-hook!
    const gentleDrift = Math.sin(this.elapsed * 0.9) * 1.4;
    const hipRight = this.spinePoint(0.84, 0);

    const startX = hipRight.x + 56;
    const startY = hipRight.y - 2;
    const cp1X = startX + 34;
    const cp1Y = startY + 4 + gentleDrift * 0.25;
    const cp2X = startX + 38;
    const cp2Y = startY - 34 + gentleDrift * 0.45;
    const endX = startX + 70 + gentleDrift * 0.35;
    const endY = startY - 35 + gentleDrift;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.customSkin) {
      const s = this.customSkin;
      const tailW = s.tailFluffy ? 20.0 : 16.0;
      if (s.outlineColor) {
        ctx.shadowColor = 'rgba(30, 32, 40, 0.22)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetY = 1.5;
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = tailW + 3.4;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      } else {
        ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
        ctx.shadowBlur = 1.6;
      }

      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, s.tailColor);
      tailGrad.addColorStop(1.0, s.tailTipColor);
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = tailW;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      if (s.tailFluffy) {
        ctx.fillStyle = s.tailTipColor;
        ctx.beginPath();
        ctx.ellipse(endX + 1, endY, 11.8, 10.2, -0.15, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cute tabby tail rings when tailStripes is enabled!
      if (s.tailStripes && (s.stripeColor || s.tailTipColor)) {
        const ringColor = s.stripeColor || s.tailTipColor;
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3.2;
        ctx.shadowBlur = 0;
        for (const t of [0.24, 0.44, 0.64, 0.82]) {
          const mt = 1 - t;
          const bx =
            mt * mt * mt * startX +
            3 * mt * mt * t * cp1X +
            3 * mt * t * t * cp2X +
            t * t * t * endX;
          const by =
            mt * mt * mt * startY +
            3 * mt * mt * t * cp1Y +
            3 * mt * t * t * cp2Y +
            t * t * t * endY;
          const tx =
            3 * mt * mt * (cp1X - startX) +
            6 * mt * t * (cp2X - cp1X) +
            3 * t * t * (endX - cp2X);
          const ty =
            3 * mt * mt * (cp1Y - startY) +
            6 * mt * t * (cp2Y - cp1Y) +
            3 * t * t * (endY - cp2Y);
          const tLen = Math.max(1, Math.hypot(tx, ty));
          const nx = (-ty / tLen) * (tailW * 0.42);
          const ny = (tx / tLen) * (tailW * 0.42);
          ctx.beginPath();
          ctx.moveTo(bx - nx, by - ny);
          ctx.lineTo(bx + nx, by + ny);
          ctx.stroke();
        }
      }

      ctx.restore();
      return;
    }

    if (this.catBreed === 'ragdoll') {
      // Plush bushy warm cocoa-taupe Ragdoll plume tail matching the real cat photo!
      ctx.shadowColor = 'rgba(48, 38, 30, 0.22)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;
      ctx.strokeStyle = '#4e4239';
      ctx.lineWidth = 23.5;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      const tailGrad = ctx.createLinearGradient(startX, startY, endX, endY);
      tailGrad.addColorStop(0.0, '#8d7e6f');
      tailGrad.addColorStop(0.5, '#726356');
      tailGrad.addColorStop(1.0, '#584b40');
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = 20.2;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
      ctx.stroke();

      // Bushy warm cocoa-taupe plume tip puff
      ctx.fillStyle = '#584b40';
      ctx.beginPath();
      ctx.ellipse(endX + 1, endY, 12.2, 10.6, -0.15, 0, Math.PI * 2);
      ctx.fill();

      // Soft warm creamy sheen along upper fluff curve
      ctx.strokeStyle = 'rgba(246, 240, 232, 0.26)';
      ctx.lineWidth = 5.0;
      ctx.beginPath();
      ctx.moveTo(startX + 4, startY - 4);
      ctx.bezierCurveTo(cp1X - 2, cp1Y - 4, cp2X - 3, cp2Y - 4, endX - 3, endY - 4);
      ctx.stroke();
    } else {
      ctx.shadowColor = 'rgba(18, 17, 18, 0.45)';
      ctx.shadowBlur = 1.6;
      ctx.strokeStyle = '#141314';
      ctx.lineWidth = 16.0;
      const tip = this.tailStrike.tip;
      const reach = this.tailStrike.reach;
      const tipX = tip?.x ?? endX;
      const tipY = tip?.y ?? endY;
      const sweep = tip ? Math.min(1, Math.abs(tipX - startX) / 160) : 0;
      const bendX = tipX + Math.min(34, (this.logicalW - tipX) * 0.42);
      const bendY = tipY - 49 - sweep * 19;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(
        cp1X + (Math.min(this.logicalW - 14, startX + 67) - cp1X) * reach,
        cp1Y - 29 * reach,
        cp2X + (bendX - cp2X) * reach,
        cp2Y + (bendY - cp2Y) * reach,
        tipX, tipY,
      );
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawCatBody(ctx: CanvasRenderingContext2D, breath: number, purrShift: number): void {
    if (this.customSkin) {
      this.drawCustomCatBody(ctx, this.customSkin, breath, purrShift);
      return;
    }
    const isRagdoll = this.catBreed === 'ragdoll';
    const catBlack = '#141314';
    const inkOutline = '#5d5148';

    // Evaluate measured left & right silhouette points deformed by flexible cat spine + unified head tilt!
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const bellySwell = 1 + this.typingHunch * 0.04;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({
          x: hcx + lx0 * cosA - relY * sinA,
          y: hcy + lx0 * sinA + relY * cosA,
        });
        rightPts.push({
          x: hcx + rx0 * cosA - relY * sinA,
          y: hcy + rx0 * sinA + relY * cosA,
        });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY = this.spinePoint(0.11, breath).y - hcy;
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    if (isRagdoll) {
      ctx.shadowColor = 'rgba(26, 30, 40, 0.24)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;
    } else {
      ctx.shadowColor = 'rgba(18, 17, 18, 0.42)';
      ctx.shadowBlur = 1.6;
    }

    if (isRagdoll) this.drawHindPaws(ctx, basePt, '#f7f5f0', inkOutline);

    // 2) Build exact smooth spline through measured silhouette slices (left top -> right top -> right down -> bottom -> left up)!
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      ctx.moveTo(leftPts[0].x + 14 * crownCos + 6 * crownSin, leftPts[0].y + 14 * crownSin - 6 * crownCos);
      ctx.quadraticCurveTo(crownPt.x, crownPt.y - 2, rightPts[0].x - 14 * crownCos + 6 * crownSin, rightPts[0].y - 14 * crownSin - 6 * crownCos);

      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      const lastR = rightPts[rightPts.length - 1];
      ctx.lineTo(lastR.x, lastR.y);

      const lastL = leftPts[leftPts.length - 1];
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, lastL.x, lastL.y);

      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        const mx = (p0.x + p1.x) * 0.5;
        const my = (p0.y + p1.y) * 0.5;
        ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    if (isRagdoll) {
      // Warm creamy ivory base coat matching the real fluffy Ragdoll photo!
      const furGrad = ctx.createRadialGradient(hcx, hcy + 68, 18, basePt.x, basePt.y - 60, 148);
      furGrad.addColorStop(0.0, '#fbf9f3');
      furGrad.addColorStop(0.68, '#f4f0e6');
      furGrad.addColorStop(1.0, '#e8e2d6');
      ctx.fillStyle = furGrad;
      ctx.fill();

      // Paint custom warm milk-tea taupe Ragdoll markings clipped cleanly inside the body silhouette!
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.clip();

      // 2a) Plush warm taupe-brown lower flanks / hips wrapping around both outer thighs (matches photo!)
      const midTorso = this.spinePoint(0.72, breath);
      for (const sgn of [-1, 1]) {
        const flankGrad = ctx.createRadialGradient(
          midTorso.x + purrShift + sgn * 70,
          midTorso.y + 8,
          14,
          midTorso.x + purrShift + sgn * 50,
          midTorso.y + 10,
          72,
        );
        flankGrad.addColorStop(0.0, 'rgba(130, 115, 100, 0.78)');
        flankGrad.addColorStop(0.50, 'rgba(156, 141, 126, 0.45)');
        flankGrad.addColorStop(0.82, 'rgba(178, 165, 150, 0.14)');
        flankGrad.addColorStop(1.0, 'rgba(190, 178, 164, 0.0)');
        ctx.fillStyle = flankGrad;
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 60, midTorso.y + 8, 52, 84, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2b) Subtle fluffy creamy-white chest lion-mane fur tufts under chin
      const neckSp = this.spinePoint(0.47, breath);
      ctx.strokeStyle = 'rgba(182, 170, 156, 0.36)';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift, neckSp.y - 2, 34, 0.22 * Math.PI, 0.78 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(neckSp.x + purrShift - 16, neckSp.y + 18, 14, 0.18 * Math.PI, 0.72 * Math.PI);
      ctx.arc(neckSp.x + purrShift + 16, neckSp.y + 18, 14, 0.28 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();

      // 2c) Custom warm milk-tea taupe crown cap & wide fluffy creamy-white blaze (1:1 match to user's real Ragdoll photos!)
      ctx.save();
      ctx.translate(hcx, hcy);
      ctx.rotate(this.headTilt);

      const maskShift = this.faceTurnX * 0.72;
      // Rich warm latte-taupe head mask covering crown, ears base, temples & outer cheeks
      const capGrad = ctx.createLinearGradient(0, -40, 0, 22);
      capGrad.addColorStop(0.0, '#8d7d6e');
      capGrad.addColorStop(0.42, '#9e8e7f');
      capGrad.addColorStop(0.84, '#b3a495');
      capGrad.addColorStop(1.0, 'rgba(186, 173, 158, 0.14)');

      ctx.fillStyle = capGrad;
      ctx.shadowColor = 'rgba(138, 122, 108, 0.45)';
      ctx.shadowBlur = 4.8;

      // Full warm milk-tea head mask curving around outer eyes & cheeks, opening into a wide soft fluffy white blaze!
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      // Soft wide fluffy dome peak of the creamy-white blaze between the brows (warm latte bridge stays connected across forehead!)
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();

      // Lighter warm champagne-beige soft forehead bridge highlight right between the ears (exact match to close-up photo!)
      ctx.shadowBlur = 5.5;
      ctx.fillStyle = 'rgba(208, 194, 176, 0.58)';
      ctx.beginPath();
      ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      // Deeper warm taupe-brown shading along outer temples below both ears
      ctx.fillStyle = 'rgba(116, 100, 86, 0.40)';
      ctx.beginPath();
      ctx.ellipse(-44 + maskShift * 0.4, -10, 21, 22, -0.18, 0, Math.PI * 2);
      ctx.ellipse(44 + maskShift * 0.4, -10, 21, 22, 0.18, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore(); // end mask head-space
      ctx.restore(); // end body clip

      // Clean refined soft warm-brown body outline so creamy fur pops crisply on BOTH light & dark wallpapers!
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = inkOutline;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = catBlack;
      ctx.fill();

      ctx.save();
      ctx.clip();
      ctx.shadowBlur = 0;
      for (const paw of [this.leftPaw, this.rightPaw]) {
        if (paw.restingLineOpacity < 0.012) continue;
        ctx.save();
        ctx.globalAlpha *= paw.restingLineOpacity;
        this.drawIdlePaw(ctx, paw, breath);
        ctx.restore();
      }
      ctx.restore();
    }

    // 3) Compact plush rounded cat ears matching ORIG 0.3s exact height (shorter & cuter, no tall rabbit ears!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.12;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.12;

    const drawOneEar = (sideSign: -1 | 1, twitch: number) => {
      ctx.save();
      ctx.translate(sideSign * 33 + this.faceTurnX * 0.18, -28);
      ctx.rotate(sideSign * (0.08 + twitch));

      const earPath = () => {
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 20);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -21, 8);
        ctx.closePath();
      };

      if (isRagdoll) {
        // Rich dark espresso-taupe ear rims fading to soft warm latte base (1:1 match to user's real cat!)
        const earGrad = ctx.createLinearGradient(0, -23, 0, 18);
        earGrad.addColorStop(0.0, '#463b33');
        earGrad.addColorStop(0.42, '#625449');
        earGrad.addColorStop(0.82, '#8b7c6e');
        earGrad.addColorStop(1.0, '#9c8d7e');
        ctx.fillStyle = earGrad;
        earPath();
        ctx.fill();

        // Stroke outer ear rim cleanly (open at bottom skull merge so there is zero seam line!)
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = '#473c34';
        ctx.lineWidth = 1.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 17);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -19, 5);
        ctx.stroke();

        // Soft warm dusty-blush cream inner ear
        ctx.fillStyle = '#dec4be';
        ctx.beginPath();
        ctx.moveTo(sideSign * 11, 10);
        ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7, -13, sideSign * 2, -11);
        ctx.bezierCurveTo(sideSign * -4, -9, sideSign * -9, -1, sideSign * -10, 8);
        ctx.closePath();
        ctx.fill();

        // Fluffy creamy-white Ragdoll ear furnishings
        ctx.strokeStyle = 'rgba(252, 249, 242, 0.90)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sideSign * -7, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -4, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 8, 10);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = catBlack;
        earPath();
        ctx.fill();
      }
      ctx.restore();
    };

    drawOneEar(-1, lTwitch);
    drawOneEar(1, rTwitch);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    const wShift = this.faceTurnX * 0.72;

    // 4) Ragdoll rosy petting blush + adorable tiny pink nose & gentle kitten smile!
    if (isRagdoll) {
      if (this.squintAmount > 0.12) {
        ctx.fillStyle = `rgba(244, 146, 166, ${(0.42 * this.squintAmount).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(wShift - 30, 13, 8.5, 4.6, -0.08, 0, Math.PI * 2);
        ctx.ellipse(wShift + 30, 13, 8.5, 4.6, 0.08, 0, Math.PI * 2);
        ctx.fill();
      }

      // Cute rosy-pink Ragdoll nose centered neatly inside the snow-white inverted-V blaze
      ctx.fillStyle = '#ee8e9e';
      ctx.beginPath();
      ctx.moveTo(wShift - 4.1, 9.6);
      ctx.quadraticCurveTo(wShift, 8.5, wShift + 4.1, 9.6);
      ctx.quadraticCurveTo(wShift + 3.2, 13.8, wShift, 14.3);
      ctx.quadraticCurveTo(wShift - 3.2, 13.8, wShift - 4.1, 9.6);
      ctx.closePath();
      ctx.fill();

      // Delicate cute kitten "w" mouth
      ctx.strokeStyle = 'rgba(72, 77, 92, 0.80)';
      ctx.lineWidth = 1.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wShift - 5.8, 16.6);
      ctx.quadraticCurveTo(wShift - 2.9, 19.6, wShift, 16.4);
      ctx.quadraticCurveTo(wShift + 2.9, 19.6, wShift + 5.8, 16.6);
      ctx.stroke();
    }

    // 5) Delicate wispy cheek whiskers adapting to 2.5D head turn
    ctx.strokeStyle = isRagdoll ? 'rgba(98, 86, 76, 0.52)' : 'rgba(205, 208, 214, 0.54)';
    ctx.lineWidth = isRagdoll ? 1.15 : 1.05;
    ctx.lineCap = 'round';
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    // 6) Expressive eyes (lemon-chartreuse for Black Cat / luminous sapphire-blue for Ragdoll!)
    this.drawEyes(ctx, wShift, -1);

    ctx.restore(); // end head

    ctx.restore();
  }

  private drawEyes(ctx: CanvasRenderingContext2D, cx: number, eyeY: number): void {
    const isRagdoll = this.catBreed === 'ragdoll';
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.85, this.privacyClose);

    // Exact measured eye spacing & size from original 0.3s & 10.6s!
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = 14.8 + this.typingHunch * 1.0;
    const ry = 13.4 - this.typingHunch * 0.5;

    for (let idx = 0; idx < 2; idx++) {
      const ex = eyeXs[idx];
      ctx.save();
      ctx.translate(ex, eyeY);

      if (this.privacyClose > 0.45) {
        ctx.strokeStyle = isRagdoll ? '#212533' : '#d4f044';
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 5.2, 13.5, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.squintAmount > 0.38 && blinkVal < 0.3) {
        if (isRagdoll) {
          // Sleek lazy drooping slits with a subtle crystal-blue underside shimmer!
          ctx.strokeStyle = 'rgba(174, 224, 255, 0.72)';
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5, 0.2);
          ctx.quadraticCurveTo(0, 2.2, 12.5, 1.8);
          ctx.stroke();

          ctx.strokeStyle = '#212533';
          ctx.lineWidth = 2.7;
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        } else {
          // Exact sleek thin horizontal lazy-slanted lemon-chartreuse slits from user's reference photo (NO grey lid blob!)
          ctx.strokeStyle = '#d4f044';
          ctx.lineWidth = 2.9;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-13.5, -0.5);
          ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75);
      ctx.rotate(curiousTilt);

      if (isRagdoll) {
        // Gentle soulful sky-cerulean Ragdoll eyes (warm & lifelike, matching user's Ragdoll!)
        const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
        irisGrad.addColorStop(0.0, '#2c5594');
        irisGrad.addColorStop(0.50, '#5a94d6');
        irisGrad.addColorStop(1.0, '#a3d2f2');
        ctx.fillStyle = irisGrad;
      } else {
        ctx.fillStyle = '#d4f044';
      }

      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();

      if (openRy > 3.2) {
        // Expressive pupil hugging lower rim when looking down at keyboard!
        const px = this.eyeLookX;
        const py = this.eyeLookY;
        const pupilRx = 6.2;
        const pupilRy = 8.8;

        ctx.fillStyle = isRagdoll ? '#101624' : '#0e0e10';
        ctx.beginPath();
        ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
        ctx.fill();

        if (isRagdoll) {
          // Crisp glossy twin starlight catchlights for dreamy Ragdoll doll eyes!
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.beginPath();
          ctx.arc(px - 3.6, py - 4.0, 2.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.beginPath();
          ctx.arc(px + 3.2, py + 3.2, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();

      if (isRagdoll && openRy > 2.2) {
        // Delicate velvety eye rim so sapphire iris frames cleanly inside the blue-grey mask
        ctx.strokeStyle = 'rgba(34, 39, 54, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private drawPointerDevice(ctx: CanvasRenderingContext2D): void {
    if (this.pointerDevice === 'trackpad') {
      if (this.usesLowProfileDesk) this.drawLargeTrackpad(ctx);
      else this.drawTrackpad(ctx);
    } else {
      this.drawMiniMouse(ctx);
    }
  }

  private lowProfileKeyBounds() {
    const rearInset = this.keyboardOrientation === 'viewer' ? DESK_KEYS_TOP_INSET : DESK_KEYS_BOTTOM_INSET;
    return {
      left: this.kbCenterX - this.kbWidth / 2 + DESK_KEYS_SIDE_INSET,
      top: this.kbCenterY - this.kbHeight / 2 + rearInset,
      unitWidth: (this.kbWidth - 2 * DESK_KEYS_SIDE_INSET) / LOW_PROFILE_LAYOUT.totalUnits,
      rowHeight: (this.kbHeight - DESK_KEYS_TOP_INSET - DESK_KEYS_BOTTOM_INSET) / LOW_PROFILE_LAYOUT.totalRows,
    };
  }

  private drawLowProfileKeyboard(ctx: CanvasRenderingContext2D): void {
    const { totalUnits, totalRows, keys } = LOW_PROFILE_LAYOUT;
    const viewer = this.keyboardOrientation === 'viewer';
    const left = this.kbCenterX - this.kbWidth / 2;
    const top = this.kbCenterY - this.kbHeight / 2;
    const lift = 3.3 - this.kbBounce * 0.8;
    const center = this.logicalW / 2;
    const bounds = this.lowProfileKeyBounds();

    ctx.save();
    ctx.save();
    ctx.shadowColor = 'rgba(9, 16, 28, 0.26)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3.2;
    ctx.fillStyle = '#7c8490';
    traceDeskRect(ctx, center, left, top, this.kbWidth, this.kbHeight, 5);
    ctx.fill();
    ctx.restore();

    const frame = ctx.createLinearGradient(0, top, 0, top + this.kbHeight);
    frame.addColorStop(0, '#f3f5f6');
    frame.addColorStop(0.48, '#b9c3cc');
    frame.addColorStop(1, '#dce0e4');
    ctx.fillStyle = frame;
    traceDeskRect(ctx, center, left, top, this.kbWidth, this.kbHeight, 5, lift);
    ctx.fill();
    ctx.strokeStyle = '#6d7581';
    ctx.lineWidth = 0.85;
    ctx.stroke();

    ctx.fillStyle = '#515b65';
    traceDeskRect(ctx, center, left + 2.4, top + 2, this.kbWidth - 4.8, this.kbHeight - 4, 3.5, lift);
    ctx.fill();

    const stripY = viewer ? top + 2.8 : top + this.kbHeight - 11;
    ctx.fillStyle = '#353c46';
    traceDeskRect(ctx, center, left + 4, stripY, this.kbWidth - 8, 8.2, 2.8, lift);
    ctx.fill();
    const stripCenter = this.projectDesk(this.kbCenterX, stripY + 4.3);
    const stripLight = ctx.createLinearGradient(
      stripCenter.x - this.kbWidth * 0.45, 0, stripCenter.x + this.kbWidth * 0.45, 0,
    );
    stripLight.addColorStop(0, '#a7e171');
    stripLight.addColorStop(0.52, '#72e4b9');
    stripLight.addColorStop(1, '#8ed8ff');
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = stripLight;
    traceDeskRect(ctx, center, left + 7, stripY + 6.9, this.kbWidth - 14, 0.65, 0.3, lift);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(stripCenter.x, stripCenter.y - lift);
    if (!viewer) ctx.rotate(Math.PI);
    ctx.fillStyle = stripLight;
    ctx.font = '700 5.4px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('R E P U B L I C   O F   G A M E R S', 0, -0.45);
    ctx.restore();

    const gap = 0.95;
    for (const key of keys) {
      const col = viewer ? key.uStart : totalUnits - key.uStart - key.uWidth;
      const row = viewer ? key.row : totalRows - 1 - key.row;
      const x = bounds.left + col * bounds.unitWidth + gap / 2;
      const y = bounds.top + row * bounds.rowHeight + gap / 2;
      const w = key.uWidth * bounds.unitWidth - gap;
      const h = bounds.rowHeight - gap;
      const press = this.keyAnims.get(key.id)?.pressAmount ?? 0;
      const keyLift = lift + 1.65 - press * 1.35;
      const lit = press > 0.14;
      const hue = 74 + (key.uStart / (totalUnits - 1)) * 108;

      ctx.fillStyle = lit ? '#819469' : '#aebac7';
      traceDeskRect(ctx, center, x - 0.2, y, w + 0.4, h, 1.6, lift);
      ctx.fill();
      ctx.fillStyle = lit ? 'hsl(83 79% 77%)' : `hsl(${hue} 30% 96%)`;
      traceDeskRect(ctx, center, x + 0.25, y + 0.15, w - 0.5, h - 0.8, 1.55, keyLift);
      ctx.fill();

      const label = key.id === 'space' ? '━' : key.id === 'esc' ? 'Esc' : key.label;
      const labelPoint = this.projectDesk(x + w / 2, y + h * 0.51);
      ctx.save();
      ctx.translate(labelPoint.x, labelPoint.y - keyLift);
      if (!viewer) ctx.rotate(Math.PI);
      ctx.fillStyle = lit ? '#252d19' : `hsl(${hue} 62% 27%)`;
      ctx.font = `700 ${label.length >= 3 ? 4.65 : 6.25}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    if (this.privacyClose > 0.08) {
      ctx.globalAlpha = this.privacyClose;
      ctx.fillStyle = 'rgba(15, 20, 32, 0.86)';
      traceDeskRect(ctx, center, left + 2, top + 2, this.kbWidth - 4, this.kbHeight - 4, 4.5, lift + 1.7);
      ctx.fill();
      ctx.fillStyle = '#fbcfe8';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔒 密码输入中 · 已隐藏按键', this.kbCenterX, this.kbCenterY);
    }
    ctx.restore();
  }

  private drawLargeTrackpad(ctx: CanvasRenderingContext2D): void {
    const left = this.mouseBaseX - DESK_TRACKPAD_WIDTH / 2;
    const top = this.mouseBaseY - DESK_TRACKPAD_DEPTH / 2;
    const center = this.logicalW / 2;
    const press = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
    const lift = 2.25 - press * 0.65;
    ctx.save();
    ctx.save();
    ctx.shadowColor = 'rgba(9, 16, 28, 0.27)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#8895a1';
    traceDeskRect(ctx, center, left, top, DESK_TRACKPAD_WIDTH, DESK_TRACKPAD_DEPTH, 8);
    ctx.fill();
    ctx.restore();

    const surface = ctx.createLinearGradient(0, top, 0, top + DESK_TRACKPAD_DEPTH);
    surface.addColorStop(0, '#f8fbff');
    surface.addColorStop(0.58, '#edf2f8');
    surface.addColorStop(1, '#dfe6ee');
    ctx.fillStyle = surface;
    ctx.strokeStyle = '#84919e';
    ctx.lineWidth = 0.9;
    traceDeskRect(ctx, center, left, top, DESK_TRACKPAD_WIDTH, DESK_TRACKPAD_DEPTH, 8, lift);
    ctx.fill();
    this.fillTrackpadClick(ctx);
    ctx.stroke();
    ctx.clip();

    const origin = this.projectDesk(this.mouseBaseX, this.mouseBaseY);
    const contact = this.getTrackpadContactWorld();
    ctx.translate(origin.x, origin.y - lift);
    this.drawTrackpadContacts(ctx, { x: contact.x - origin.x, y: contact.y - origin.y });
    ctx.restore();
  }

  private drawTrackpad(ctx: CanvasRenderingContext2D): void {
    const press = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
    const contact = this.getTrackpadContact();
    ctx.save();
    ctx.translate(this.mouseBaseX, this.mouseBaseY);
    ctx.rotate(this.kbTiltRad);
    const viewerFacing = this.keyboardOrientation === 'viewer';
    ctx.transform(1, 0, viewerFacing ? 0 : -0.10, 0.84, 0, 0);
    const traceSurface = (top: number, bottom: number) => {
      if (viewerFacing) {
        this.trapezoidPath(ctx, TRACKPAD_REAR_HALF_WIDTH, TRACKPAD_FRONT_HALF_WIDTH, top, bottom, 6);
      } else {
        this.roundRect(ctx, -26, top, 52, bottom - top, 6);
      }
    };

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#9298a0';
    traceSurface(-18, 21);
    ctx.fill();
    ctx.restore();

    const surface = ctx.createLinearGradient(0, -21, 0, 21);
    surface.addColorStop(0, '#f0f2f4');
    surface.addColorStop(1, '#d2d6da');
    ctx.fillStyle = surface;
    ctx.strokeStyle = '#727b85';
    ctx.lineWidth = 1.2;
    traceSurface(-20 + press * 1.5, 18 + press * 1.5);
    ctx.fill();
    this.fillTrackpadClick(ctx);
    ctx.stroke();
    ctx.clip();
    this.drawTrackpadContacts(ctx, contact);
    ctx.restore();
  }

  private fillTrackpadClick(ctx: CanvasRenderingContext2D): void {
    const right = this.mouseRightDown || (!this.mouseLeftDown && this.mouseRightPress > this.mouseLeftPress);
    const press = right ? this.mouseRightPress : this.mouseLeftPress;
    if (press <= 0.01) return;

    ctx.save();
    ctx.globalAlpha *= press;
    ctx.fillStyle = right ? TRACKPAD_RIGHT_COLOR : TRACKPAD_LEFT_COLOR;
    ctx.fill();
    ctx.restore();
  }

  private drawTrackpadContacts(ctx: CanvasRenderingContext2D, contact: Vec2): void {
    const press = Math.max(this.mouseLeftPress, this.mouseRightPress, this.mouseMiddlePress);
    const moving = Math.max(0, 1 - (performance.now() - this.lastMouseMoveAt) / TRACKPAD_GLIDE_IDLE_MS);
    const drawContact = (offset: number, intensity: number, color: string) => {
      if (intensity <= 0.02) return;
      ctx.globalAlpha = intensity;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(contact.x + offset, contact.y, 4.6 + press * 2, 4.6 + press * 2, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    const colors = this.getMouseButtonColors();
    if (this.mouseRightPress > 0.05 || this.mouseScrollFlash > 0.05) {
      const intensity = Math.max(this.mouseRightPress, this.mouseScrollFlash) * 0.82;
      const color = this.mouseRightPress > this.mouseScrollFlash ? colors.right : colors.middle;
      drawContact(-6, intensity, color);
      drawContact(6, intensity, color);
    } else {
      drawContact(0, Math.max(press * 0.82, moving * 0.33), colors.left);
    }
  }

  private drawMiniMouse(ctx: CanvasRenderingContext2D): void {
    const mx = this.mouseBaseX + this.mouseOffsetX;
    const my = this.mouseBaseY + this.mouseOffsetY;
    const rx = MOUSE_HALF_WIDTH;
    const ry = 23.0;
    const lPress = this.mouseLeftPress;
    const rPress = this.mouseRightPress;
    const mPress = Math.max(this.mouseMiddlePress, this.mouseScrollFlash);
    const colors = this.getMouseButtonColors();

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(this.keyboardOrientation === 'viewer' ? this.kbTiltRad : -0.06);

    // Soft 3D base rim / drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3.5;
    ctx.fillStyle = '#c8cac4';
    ctx.beginPath();
    ctx.ellipse(0, 1.8, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Main mouse palm shell (rear/palm at TOP closest to cat; split L/R buttons at BOTTOM pointing away from cat)
    const palmGrad = ctx.createLinearGradient(0, -ry, 0, 2);
    palmGrad.addColorStop(0.0, '#ecece7');
    palmGrad.addColorStop(1.0, '#f4f4f0');
    ctx.fillStyle = palmGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Clip inside mouse silhouette to render strictly separated Left / Right front button plates!
    const isCatFacing = this.keyboardOrientation === 'cat';
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();

    // Orientation-aware button/wheel geometry:
    // - 'cat' (180°): palm at TOP, buttons at BOTTOM, L = +X (inner), R = -X (outer)
    // - 'viewer' (0°): buttons at TOP, palm at BOTTOM, L = -X (left), R = +X (right)
    ctx.save();
    if (!isCatFacing) {
      ctx.scale(-1, -1);
    }

    const traceSeam = () => {
      ctx.moveTo(-rx - 2, -0.8);
      ctx.quadraticCurveTo(0, 1.8, rx + 2, -0.8);
    };

    // 1) Left Mouse Button plate (+X half in local coords -> inner-bottom in cat mode, top-left in viewer mode)
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.quadraticCurveTo(rx * 0.52, 0.4, rx + 2, -0.8);
    ctx.lineTo(rx + 2, ry + 2);
    ctx.lineTo(0, ry + 2);
    ctx.closePath();
    ctx.fillStyle = lPress > 0.08 ? colors.left : '#fafaf7';
    ctx.fill();
    if (lPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * lPress).toFixed(3)})`;
      ctx.fillRect(0, -1, rx + 2, 3.8);
      ctx.fillRect(0, -1, 2.2, ry + 2);
    }

    // 2) Right Mouse Button plate (-X half in local coords -> outer-bottom in cat mode, top-right in viewer mode)
    ctx.beginPath();
    ctx.moveTo(-rx - 2, -0.8);
    ctx.quadraticCurveTo(-rx * 0.52, 0.4, 0, 0.5);
    ctx.lineTo(0, ry + 2);
    ctx.lineTo(-rx - 2, ry + 2);
    ctx.closePath();
    ctx.fillStyle = rPress > 0.08 ? colors.right : '#fafaf7';
    ctx.fill();
    if (rPress > 0.08) {
      ctx.fillStyle = `rgba(18, 22, 28, ${(0.18 * rPress).toFixed(3)})`;
      ctx.fillRect(-rx - 2, -1, rx + 2, 3.8);
      ctx.fillRect(-2.2, -1, 2.2, ry + 2);
    }

    // Crisp horizontal palm-to-button seam & vertical center L/R split line
    ctx.strokeStyle = 'rgba(42, 45, 52, 0.56)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    traceSeam();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(42, 45, 52, 0.66)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, 0.6);
    ctx.lineTo(0, ry + 1);
    ctx.stroke();

    // Recessed scroll wheel housing + interactive wheel (middle click & scroll glow)
    ctx.fillStyle = '#2d2f36';
    this.roundRect(ctx, -2.5, 4.2, 5.0, 9.4, 2.5);
    ctx.fill();

    ctx.fillStyle = mPress > 0.12 ? colors.middle : '#6b6f78';
    this.roundRect(ctx, -1.7, 5.0 + this.mouseMiddlePress * 0.8, 3.4, 7.6, 1.7);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.lineTo(1.0, 8.8 + this.mouseMiddlePress * 0.8);
    ctx.stroke();

    ctx.restore(); // end local orientation transform

    // Always draw upright crisp L / R button legends in unobstructed front tips!
    ctx.font = '800 7.6px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lx = isCatFacing ? 7.4 : -7.4;
    const rxLbl = isCatFacing ? -7.4 : 7.4;
    const lyBase = isCatFacing ? 14.0 : -14.0;
    const pressDir = isCatFacing ? 0.9 : -0.9;
    ctx.fillStyle = lPress > 0.12 ? '#14161a' : 'rgba(72, 76, 86, 0.56)';
    ctx.fillText('L', lx, lyBase + lPress * pressDir);
    ctx.fillStyle = rPress > 0.12 ? '#ffffff' : 'rgba(72, 76, 86, 0.56)';
    ctx.fillText('R', rxLbl, lyBase + rPress * pressDir);

    ctx.restore(); // end mouse clip

    // Crisp outer silhouette stroke
    ctx.strokeStyle = '#2b2d34';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D): void {
    if (this.usesLowProfileDesk) {
      this.drawLowProfileKeyboard(ctx);
      return;
    }

    const layout = this.currentLayout;
    const isCatFacing = this.keyboardOrientation === 'cat';
    const is108 = this.keyboardLayout === '108';
    const padX = 7;
    const padY = 6;
    const innerW = this.kbWidth - padX * 2;
    const innerH = this.kbHeight - padY * 2;

    ctx.save();
    ctx.translate(this.kbCenterX, this.kbCenterY + this.kbBounce * 1.1);
    ctx.rotate(this.kbTiltRad);

    // True 3D desk trapezoid perspective: far edge (top) is narrower, near edge (bottom) is wider,
    // cleanly re-projected for BOTH cat-facing (Spacebar at narrow top) and viewer-facing (Esc/F-row at narrow top)!
    const topHalfW = (this.kbWidth * 0.955) / 2;
    const botHalfW = (this.kbWidth * 1.035) / 2;
    const halfH = this.kbHeight / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
    ctx.shadowBlur = 11;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#191a1e';
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH + 3.5, halfH + 5.5, 6.5);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#24262c';
    ctx.strokeStyle = '#363840';
    ctx.lineWidth = 1.1;
    this.trapezoidPath(ctx, topHalfW, botHalfW, -halfH, halfH, 6.5);
    ctx.fill();
    ctx.stroke();

    // Bright clean light-grey inner keybed matching ORIG 0.3s bright airy white keyboard!
    ctx.fillStyle = '#d4d6d1';
    this.trapezoidPath(ctx, topHalfW - 5, botHalfW - 5, -halfH + 4, halfH - 4, 3.5);
    ctx.fill();

    const rowH = innerH / layout.totalRows;
    const unitW = innerW / layout.totalUnits;
    const gap = is108 ? 0.85 : 0.9;

    for (const key of layout.keys) {
      const anim = this.keyAnims.get(key.id);
      const press = anim ? anim.pressAmount : 0;

      const rY = key.rowY ?? key.row;
      const rSpan = key.rowSpan ?? 1;
      const screenRowTop = isCatFacing ? layout.totalRows - (rY + rSpan) : rY;
      const screenUStart = isCatFacing
        ? layout.totalUnits - (key.uStart + key.uWidth)
        : key.uStart;

      const rowCenterFrac = (screenRowTop + rSpan * 0.5) / layout.totalRows;
      const depthScale = 0.94 + rowCenterFrac * 0.09;

      const rawX = -innerW / 2 + screenUStart * unitW + gap * 0.5;
      const rawW = key.uWidth * unitW - gap;
      const x = rawX * depthScale;
      const w = rawW * depthScale;
      const y = -innerH / 2 + screenRowTop * rowH + gap * 0.5 + press * 2.0;
      const h = rSpan * rowH - gap - 0.8;

      let topColor = '#f8f8f5';
      let sideColor = '#d0d2cc';
      if (press > 0.14) {
        topColor = this.customSkin
          ? this.customSkin.accentColor
          : this.catBreed === 'dafeiyu'
            ? '#5cc8ff'
            : this.catBreed === 'ragdoll'
              ? '#7ac7ff'
              : '#d2f244';
        sideColor = this.customSkin
          ? this.customSkin.accentSideColor
          : this.catBreed === 'dafeiyu'
            ? '#2563eb'
            : this.catBreed === 'ragdoll'
              ? '#4690d8'
              : '#8cb014';
      } else if (key.accent === 'orange') {
        topColor = '#f4a524';
        sideColor = '#c27a10';
      } else if (key.accent === 'mod') {
        topColor = '#efefeb';
        sideColor = '#c7c9c3';
      }

      ctx.fillStyle = sideColor;
      this.roundRect(ctx, x, y + 1.4, w, h, 1.8);
      ctx.fill();

      ctx.fillStyle = topColor;
      this.roundRect(ctx, x, y, w, h - 0.9, 1.8);
      ctx.fill();

      // Keycap legends: rotated 180° in cat-facing mode, upright 0° in viewer-facing mode!
      const legend = key.id === 'space' ? '' : key.id === 'esc' ? 'Esc' : key.label;
      if (legend) {
        const isWideWord = legend.length >= 3;
        const fontSize = is108
          ? isWideWord
            ? 5.0
            : legend.length === 2
              ? 5.8
              : 7.2
          : isWideWord
            ? 5.6
            : legend.length === 2
              ? 6.4
              : 7.8;
        ctx.save();
        ctx.translate(x + w * 0.5, y + (h - 0.9) * 0.50);
        if (isCatFacing) {
          ctx.rotate(Math.PI);
        }
        ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = press > 0.14
          ? '#111214'
          : key.accent === 'orange'
            ? '#ffffff'
            : '#2c2f36';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(legend, 0, 0);
        ctx.restore();
      }
    }

    if (this.privacyClose > 0.08) {
      ctx.save();
      ctx.globalAlpha = this.privacyClose;
      ctx.fillStyle = 'rgba(15, 20, 32, 0.74)';
      this.trapezoidPath(ctx, topHalfW - 2, botHalfW - 2, -halfH + 1.5, halfH - 1.5, 5.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.45)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = '700 11.5px "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = '#fbcfe8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dots = performance.now() - this.privacyTypingAt < 350 ? ' • • •' : '';
      const label = this.catBreed === 'dafeiyu' ? '🔒 非礼勿视 · 已隐藏按键' : '🔒 密码输入中 · 已隐藏按键';
      ctx.fillText(label + dots, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * True-scale plush velvety cat arm & chubby rounded paw ball (1:1 match to reference photo & 8.3s / 13.2s / 31.0s!)
   */
  private drawForeleg(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    const shoulder = this.getLiveShoulder(paw, breath);
    const { x, y } = paw.pos;
    const dx = x - shoulder.x;
    const dy = y - shoulder.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const side = paw.side === 'left' ? -1 : 1;
    const elbowX = shoulder.x + dx * 0.47 + side * 10 * paw.curl;
    const elbowY = shoulder.y + dy * 0.47 + 13 * paw.curl;
    const shoulderRadius = 14;
    const pawWidth = 12.7 + 2.6 * paw.squash;
    const cap = 15.5 - 2.8 * paw.squash;
    const silhouette = new Path2D();
    silhouette.moveTo(shoulder.x + nx * shoulderRadius, shoulder.y + ny * shoulderRadius);
    silhouette.quadraticCurveTo(elbowX + nx * 11, elbowY + ny * 11, x + nx * pawWidth, y + ny * pawWidth);
    silhouette.bezierCurveTo(
      x + nx * pawWidth + ux * cap, y + ny * pawWidth + uy * cap,
      x - nx * pawWidth + ux * cap, y - ny * pawWidth + uy * cap,
      x - nx * pawWidth, y - ny * pawWidth,
    );
    silhouette.quadraticCurveTo(elbowX - nx * 11, elbowY - ny * 11,
      shoulder.x - nx * shoulderRadius, shoulder.y - ny * shoulderRadius);
    silhouette.quadraticCurveTo(shoulder.x - ux * shoulderRadius, shoulder.y - uy * shoulderRadius,
      shoulder.x + nx * shoulderRadius, shoulder.y + ny * shoulderRadius);
    silhouette.closePath();

    const skin = this.customSkin;
    const ragdoll = this.catBreed === 'ragdoll';
    const armColor = skin?.armColor ?? (ragdoll ? '#f5f1e8' : '#141314');
    const pawColor = skin?.pawColor ?? (ragdoll ? '#fcfaf4' : armColor);
    const edge = skin ? (skin.pawOutlineColor || skin.outlineColor) : ragdoll ? '#66574f' : null;

    if (this.isSolidBlackCat) {
      ctx.fillStyle = armColor;
      ctx.fill(silhouette);
      return;
    }

    ctx.save();
    ctx.globalAlpha *= paw.exposure;
    ctx.fillStyle = armColor;
    if (armColor !== pawColor) {
      const fur = ctx.createLinearGradient(shoulder.x, shoulder.y, x, y);
      fur.addColorStop(0, armColor);
      fur.addColorStop(0.71, armColor);
      fur.addColorStop(0.97, pawColor);
      ctx.fillStyle = fur;
    }
    ctx.fill(silhouette);

    if (skin || (ragdoll && paw.side === 'right')) {
      ctx.save();
      ctx.clip(silhouette);
      const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
      for (const spot of skin?.spots ?? []) {
        if (spot.part !== armPart) continue;
        const along = Math.max(0.1, Math.min(0.9, spot.x));
        ctx.save();
        ctx.globalAlpha *= spot.opacity ?? 0.85;
        ctx.fillStyle = spot.color;
        ctx.beginPath();
        ctx.ellipse(
          shoulder.x + dx * along + nx * spot.y, shoulder.y + dy * along + ny * spot.y,
          Math.max(2, spot.rx), Math.max(2, spot.ry), Math.atan2(dy, dx) + (spot.rotation ?? 0),
          0, Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();
      }
      if (ragdoll && paw.side === 'right') {
        ctx.fillStyle = 'rgba(134, 118, 102, 0.68)';
        ctx.beginPath();
        ctx.ellipse(shoulder.x + dx * 0.61, shoulder.y + dy * 0.61,
          Math.min(13, length * 0.16), 8, Math.atan2(dy, dx), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    const crease = skin?.armCreaseColor ?? '#b9bbc1';
    const rim = ctx.createLinearGradient(shoulder.x, shoulder.y, x, y);
    rim.addColorStop(0, 'transparent');
    rim.addColorStop(0.38, 'transparent');
    rim.addColorStop(0.78, edge ?? crease);
    rim.addColorStop(1, edge ?? crease);
    ctx.strokeStyle = rim;
    ctx.lineWidth = ragdoll ? 1.3 : 1.1;
    ctx.globalAlpha *= edge ? 0.66 : paw.crease * 0.34;
    ctx.stroke(silhouette);
    ctx.restore();
  }

  private drawHindPaws(
    ctx: CanvasRenderingContext2D, base: Vec2, color: string, outline?: string | null,
  ): void {
    const t = Math.max(0, Math.min(1, (this.hindPawLift - 0.06) / 0.82));
    const reveal = t * t * (3 - 2 * t);
    if (reveal < 0.005) return;

    const tuck = (1 - reveal) * 8;
    ctx.save();
    ctx.globalAlpha *= reveal;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.9;
    if (outline) ctx.strokeStyle = outline;
    for (const [x, y, width] of [[-42, -3, 14.5], [32, -1, 15]]) {
      ctx.beginPath();
      ctx.ellipse(base.x + x, base.y + y - tuck, width, 11.5, 0, 0, Math.PI * 2);
      ctx.fill();
      if (outline) {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  private drawPaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    if (!this.isSolidBlackCat && paw.exposure < 1) {
      ctx.save();
      ctx.globalAlpha *= 1 - paw.exposure;
      this.drawIdlePaw(ctx, paw, breath);
      ctx.restore();
    }
    if (paw.exposure > 0) this.drawForeleg(ctx, paw, breath);
  }

  private drawIdlePaw(ctx: CanvasRenderingContext2D, paw: PawState, breath: number): void {
    const topSp = this.spinePoint(0.66, breath);
    const midSp = this.spinePoint(0.84, breath);
    const botSp = this.spinePoint(1.0, breath);
    const sign = paw.side === 'left' ? -1 : 1;

    const outerTopX = topSp.x + sign * 41;
    const outerBotX = botSp.x + sign * 35;
    const innerTopX = topSp.x + sign * 6.5;
    const innerBotX = botSp.x + sign * 9.5;

    if (this.customSkin) {
      this.drawCustomIdleLegDetails(ctx, this.customSkin, paw, topSp, midSp, botSp, sign, outerTopX, outerBotX, innerTopX, innerBotX);
      return;
    }

    // Signature warm taupe-brown oval leg patch on viewer's RIGHT seated front leg (1:1 match to user's real Ragdoll!)
    const ragdoll = this.catBreed === 'ragdoll';
    if (ragdoll && paw.side === 'right') {
      ctx.save();
      ctx.fillStyle = 'rgba(134, 118, 102, 0.80)';
      ctx.shadowColor = 'rgba(134, 118, 102, 0.40)';
      ctx.shadowBlur = 3.0;
      ctx.beginPath();
      ctx.ellipse(midSp.x + 21, midSp.y + 12, 9.5, 13.5, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Crisp subtle outer leg curve & inner leg-gap line (4 total lines across both legs — exact ORIG 0.3s!)
    const lineGrad = ctx.createLinearGradient(topSp.x, topSp.y, botSp.x, botSp.y);
    if (ragdoll) {
      lineGrad.addColorStop(0.0, 'rgba(93, 81, 72, 0)');
      lineGrad.addColorStop(0.18, 'rgba(93, 81, 72, 0.62)');
      lineGrad.addColorStop(0.92, 'rgba(93, 81, 72, 0.68)');
      lineGrad.addColorStop(1.0, 'rgba(93, 81, 72, 0.28)');
    } else {
      lineGrad.addColorStop(0.0, 'rgba(78, 77, 84, 0)');
      lineGrad.addColorStop(0.25, 'rgba(78, 77, 84, 0.82)');
      lineGrad.addColorStop(0.85, 'rgba(78, 77, 84, 0.76)');
      lineGrad.addColorStop(1.0, 'rgba(78, 77, 84, 0.36)');
    }

    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = ragdoll ? 1.55 : 1.4;
    ctx.lineCap = 'round';

    // Outer front-leg separation line (gently curves inward toward paw!)
    ctx.beginPath();
    ctx.moveTo(outerTopX, topSp.y);
    ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
    ctx.stroke();

    // Inner front-leg gap line (tapers slightly outward toward paws, exact inverted narrow V from ORIG 0.3s!)
    ctx.beginPath();
    ctx.moveTo(innerTopX, topSp.y + 10);
    ctx.lineTo(innerBotX, botSp.y - 1);
    ctx.stroke();
  }

  private drawKeyBubbles(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();

    for (const b of this.bubbles) {
      const age = now - b.createdAt;
      const t = Math.min(1, age / b.lifetime);

      let scale = 1;
      if (t < 0.11) {
        const p = t / 0.11;
        scale = 0.62 + Math.sin(p * Math.PI * 0.65) * 0.44;
      } else if (t > 0.76) {
        scale = 1 - ((t - 0.76) / 0.24) * 0.1;
      }
      const alpha = t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(scale, scale);

      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      const textW = ctx.measureText(b.label).width;
      const boxW = b.isSpace ? 40 : Math.max(24, textW + 13);
      const boxH = 24;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = '#c8cac6';
      this.roundRect(ctx, bx, by + 2.2, boxW, boxH, 5.5);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(38, 40, 46, 0.42)';
      ctx.lineWidth = 1.05;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.3, 5.5);
      ctx.fill();
      ctx.stroke();

      if (b.isSpace) {
        ctx.strokeStyle = '#222429';
        ctx.lineWidth = 1.55;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-9, -1);
        ctx.lineTo(-9, 2.0);
        ctx.lineTo(9, 2.0);
        ctx.lineTo(9, -1);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1e2025';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, 0, -0.5);
      }

      ctx.restore();
    }
  }

  private drawMouseBadges(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    for (let i = 0; i < this.mouseBadges.length; i++) {
      const b = this.mouseBadges[i];
      const t = Math.min(1, (now - b.createdAt) / b.lifetime);
      let scale = 1;
      if (t < 0.14) {
        scale = 0.65 + Math.sin((t / 0.14) * Math.PI * 0.65) * 0.42;
      } else if (t > 0.72) {
        scale = 1 - ((t - 0.72) / 0.28) * 0.12;
      }
      const alpha = t < 0.68 ? 1 : Math.max(0, 1 - (t - 0.68) / 0.32);
      const liftY = t * 14 + (this.mouseBadges.length - 1 - i) * 18;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y - liftY);
      ctx.scale(scale, scale);

      const boxW = 34;
      const boxH = 19;
      const bx = -boxW / 2;
      const by = -boxH / 2;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;

      ctx.fillStyle = '#22242a';
      this.roundRect(ctx, bx, by + 1.6, boxW, boxH, 5);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = b.color;
      ctx.strokeStyle = 'rgba(20, 22, 28, 0.45)';
      ctx.lineWidth = 1.0;
      this.roundRect(ctx, bx, by, boxW, boxH - 1.0, 5);
      ctx.fill();
      ctx.stroke();

      ctx.font = '800 9.5px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = b.label === 'RMB' && b.color === '#ff7b3b' ? '#ffffff' : '#14161a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, -0.3);

      ctx.restore();
    }
  }

  private drawCustomCatBody(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    breath: number,
    purrShift: number,
  ): void {
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];
    const bellySwell = 1 + this.typingHunch * 0.04;
    const headCenter = this.spinePoint(0.24, breath);
    const hcx = headCenter.x + purrShift;
    const hcy = headCenter.y;

    for (const slice of BODY_SLICES) {
      const sp = this.spinePoint(slice.t, breath);
      const widen = slice.t > 0.45 ? bellySwell : 1;
      const hw = slice.hw * widen;

      if (slice.t <= 0.38) {
        const tiltW = slice.t <= 0.30 ? 1.0 : (0.42 - slice.t) / 0.12;
        const ang = this.headTilt * tiltW;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const relY = sp.y - hcy;
        const lx0 = sp.x + purrShift - hw - hcx;
        const rx0 = sp.x + purrShift + hw - hcx;
        leftPts.push({ x: hcx + lx0 * cosA - relY * sinA, y: hcy + lx0 * sinA + relY * cosA });
        rightPts.push({ x: hcx + rx0 * cosA - relY * sinA, y: hcy + rx0 * sinA + relY * cosA });
      } else {
        leftPts.push({ x: sp.x + purrShift - hw, y: sp.y });
        rightPts.push({ x: sp.x + purrShift + hw, y: sp.y });
      }
    }

    const crownRelY = this.spinePoint(0.11, breath).y - hcy;
    const crownPt = {
      x: hcx - crownRelY * Math.sin(this.headTilt),
      y: hcy + crownRelY * Math.cos(this.headTilt),
    };
    const basePt = this.spinePoint(1.0, breath);

    ctx.save();
    ctx.shadowColor = s.isDarkBase ? 'rgba(18, 17, 18, 0.42)' : 'rgba(30, 32, 42, 0.22)';
    ctx.shadowBlur = s.isDarkBase ? 1.6 : 5;
    if (!s.isDarkBase) ctx.shadowOffsetY = 2;

    this.drawHindPaws(ctx, basePt, s.pawColor, s.pawOutlineColor || s.outlineColor);

    // 2) Unified flexible body path
    const traceBodyPath = () => {
      ctx.beginPath();
      const crownCos = Math.cos(this.headTilt);
      const crownSin = Math.sin(this.headTilt);
      ctx.moveTo(leftPts[0].x + 14 * crownCos + 6 * crownSin, leftPts[0].y + 14 * crownSin - 6 * crownCos);
      ctx.quadraticCurveTo(crownPt.x, crownPt.y - 2, rightPts[0].x - 14 * crownCos + 6 * crownSin, rightPts[0].y - 14 * crownSin - 6 * crownCos);
      ctx.lineTo(rightPts[0].x, rightPts[0].y);
      for (let i = 0; i < rightPts.length - 1; i++) {
        const p0 = rightPts[i];
        const p1 = rightPts[i + 1];
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      }
      ctx.lineTo(rightPts[rightPts.length - 1].x, rightPts[rightPts.length - 1].y);
      ctx.quadraticCurveTo(basePt.x + purrShift, basePt.y + 6, leftPts[leftPts.length - 1].x, leftPts[leftPts.length - 1].y);
      for (let i = leftPts.length - 1; i > 0; i--) {
        const p0 = leftPts[i];
        const p1 = leftPts[i - 1];
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      }
      ctx.lineTo(leftPts[0].x, leftPts[0].y);
      ctx.closePath();
    };

    traceBodyPath();
    const furGrad = ctx.createRadialGradient(hcx, hcy + 65, 18, basePt.x, basePt.y - 60, 150);
    furGrad.addColorStop(0.0, s.furColor);
    furGrad.addColorStop(1.0, s.furSecondaryColor);
    ctx.fillStyle = furGrad;
    ctx.fill();

    // 3) Clipped coat pattern markings & custom spots
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.clip();

    const midTorso = this.spinePoint(0.70, breath);
    const chestSp = this.spinePoint(0.56, breath);

    if (s.flankColor) {
      for (const sgn of [-1, 1]) {
        ctx.save();
        ctx.globalAlpha = 0.62;
        ctx.fillStyle = s.flankColor;
        ctx.shadowColor = s.flankColor;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.ellipse(midTorso.x + purrShift + sgn * 62, midTorso.y + 6, 48, 82, sgn * -0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(chestSp.x + purrShift, chestSp.y + 38, 36, 62, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.pattern === 'tabby' && s.stripeColor) {
      ctx.strokeStyle = s.stripeColor;
      ctx.lineCap = 'round';
      ctx.lineWidth = 4.6;
      ctx.globalAlpha = 0.65;
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const ty = midTorso.y - 26 + i * 20;
          ctx.beginPath();
          ctx.moveTo(midTorso.x + purrShift + sgn * 74, ty);
          ctx.quadraticCurveTo(midTorso.x + purrShift + sgn * 56, ty + 3, midTorso.x + purrShift + sgn * 42, ty + 7);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 4;
      ctx.shadowColor = orangePatch;
      ctx.fillStyle = orangePatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift - 54, midTorso.y + 10, 38, 52, -0.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = darkPatch;
      ctx.fillStyle = darkPatch;
      ctx.beginPath();
      ctx.ellipse(midTorso.x + purrShift + 56, midTorso.y - 4, 36, 56, 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Body custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'body') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        midTorso.x + purrShift + spot.x * 65,
        midTorso.y + spot.y * 65,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    // Head-space patterns (rotate seamlessly with headTilt!)
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);
    const maskShift = this.faceTurnX * 0.72;

    if (s.pattern === 'bicolor' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 4.5;
      ctx.beginPath();
      ctx.moveTo(-74, -44);
      ctx.lineTo(74, -44);
      ctx.lineTo(70, 20);
      ctx.quadraticCurveTo(maskShift + 42, 18, maskShift + 26, 9);
      ctx.quadraticCurveTo(maskShift + 17, 0, maskShift + 13.5, -13);
      ctx.quadraticCurveTo(maskShift + 7, -21.5, maskShift, -22.5);
      ctx.quadraticCurveTo(maskShift - 7, -21.5, maskShift - 13.5, -13);
      ctx.quadraticCurveTo(maskShift - 17, 0, maskShift - 26, 9);
      ctx.quadraticCurveTo(maskShift - 42, 18, -70, 20);
      ctx.closePath();
      ctx.fill();
      if (s.foreheadBridgeColor) {
        ctx.fillStyle = s.foreheadBridgeColor;
        ctx.shadowBlur = 5.5;
        ctx.beginPath();
        ctx.ellipse(maskShift, -32, 18, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (s.pattern === 'tuxedo' && s.bellyBibColor) {
      ctx.fillStyle = s.bellyBibColor;
      ctx.beginPath();
      ctx.ellipse(maskShift, 22, 26, 15, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.pattern === 'siamese' && s.maskColor) {
      ctx.save();
      ctx.fillStyle = s.maskColor;
      ctx.shadowColor = s.maskColor;
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.ellipse(maskShift, 3, 42, 27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'calico') {
      const orangePatch = s.maskColor || '#ea9446';
      const darkPatch = s.calicoPatchColor || '#3c3634';
      ctx.save();
      ctx.shadowBlur = 4;
      ctx.fillStyle = orangePatch;
      ctx.shadowColor = orangePatch;
      ctx.beginPath();
      ctx.ellipse(-34 + maskShift * 0.4, -18, 34, 28, -0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = darkPatch;
      ctx.shadowColor = darkPatch;
      ctx.beginPath();
      ctx.ellipse(36 + maskShift * 0.4, -16, 32, 26, 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (s.pattern === 'tabby' && s.stripeColor) {
      // Iconic tabby forehead "M" & cheek stripes!
      ctx.strokeStyle = s.stripeColor;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.78;
      // Center M stripes on forehead
      ctx.beginPath();
      ctx.moveTo(maskShift - 11, -30);
      ctx.lineTo(maskShift - 8, -19);
      ctx.moveTo(maskShift, -32);
      ctx.lineTo(maskShift, -18);
      ctx.moveTo(maskShift + 11, -30);
      ctx.lineTo(maskShift + 8, -19);
      ctx.stroke();
      // Cheek tiger stripes
      ctx.lineWidth = 2.8;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sgn * 58, 6);
        ctx.lineTo(sgn * 42, 9);
        ctx.moveTo(sgn * 56, 14);
        ctx.lineTo(sgn * 41, 16);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Head custom spots
    for (const spot of s.spots) {
      if (spot.part !== 'head') continue;
      ctx.save();
      ctx.globalAlpha = spot.opacity ?? 0.85;
      ctx.fillStyle = spot.color;
      ctx.beginPath();
      ctx.ellipse(
        maskShift + spot.x * 52,
        spot.y * 36,
        Math.max(2, spot.rx),
        Math.max(2, spot.ry),
        spot.rotation || 0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }

    ctx.restore(); // end head-space patterns
    ctx.restore(); // end body clip

    if (s.outlineColor) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      traceBodyPath();
      ctx.strokeStyle = s.outlineColor;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // 4) Ears, face features & eyes in head-space
    ctx.save();
    ctx.translate(hcx, hcy);
    ctx.rotate(this.headTilt);

    const lTwitch = Math.sin(this.earTwitchLeft * Math.PI) * 0.12;
    const rTwitch = Math.sin(this.earTwitchRight * Math.PI) * 0.12;

    const drawCustomEar = (sideSign: -1 | 1, twitch: number) => {
      ctx.save();
      ctx.translate(sideSign * 33 + this.faceTurnX * 0.18, -28);
      ctx.rotate(sideSign * (0.08 + twitch));

      const earPath = () => {
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 20);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -21, 8);
        ctx.closePath();
      };

      const baseEarCol =
        s.pattern === 'calico' && sideSign === -1
          ? s.maskColor || s.earOuterColor
          : s.earOuterColor;
      const earGrad = ctx.createLinearGradient(0, -23, 0, 18);
      earGrad.addColorStop(0.0, s.earTipColor || baseEarCol);
      earGrad.addColorStop(1.0, baseEarCol);
      ctx.fillStyle = earGrad;
      earPath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (s.outlineColor) {
        ctx.strokeStyle = s.outlineColor;
        ctx.lineWidth = 1.85;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * 19, 17);
        ctx.bezierCurveTo(sideSign * 19, -8, sideSign * 12, -23, sideSign * 3, -21);
        ctx.bezierCurveTo(sideSign * -8, -18, sideSign * -16, -6, sideSign * -19, 5);
        ctx.stroke();
      }

      if (s.earInnerColor) {
        ctx.fillStyle = s.earInnerColor;
        ctx.beginPath();
        ctx.moveTo(sideSign * 11, 10);
        ctx.bezierCurveTo(sideSign * 11, -3, sideSign * 7, -13, sideSign * 2, -11);
        ctx.bezierCurveTo(sideSign * -4, -9, sideSign * -9, -1, sideSign * -10, 8);
        ctx.closePath();
        ctx.fill();
      }

      if (s.earTuftColor) {
        ctx.strokeStyle = s.earTuftColor;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sideSign * -6, 6);
        ctx.quadraticCurveTo(sideSign * -1, 3, sideSign * 5, 6);
        ctx.moveTo(sideSign * -3, 10);
        ctx.quadraticCurveTo(sideSign * 2, 7.5, sideSign * 7, 10);
        ctx.stroke();
      }
      ctx.restore();
    };

    drawCustomEar(-1, lTwitch);
    drawCustomEar(1, rTwitch);

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    const wShift = this.faceTurnX * 0.72;

    // Blush on petting
    if (s.blushColor && this.squintAmount > 0.12) {
      ctx.save();
      ctx.globalAlpha = 0.42 * this.squintAmount;
      ctx.fillStyle = s.blushColor;
      ctx.beginPath();
      ctx.ellipse(wShift - 30, 13, 8.5, 4.6, -0.08, 0, Math.PI * 2);
      ctx.ellipse(wShift + 30, 13, 8.5, 4.6, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Nose & mouth
    if (s.noseColor) {
      ctx.fillStyle = s.noseColor;
      ctx.beginPath();
      ctx.moveTo(wShift - 4.1, 9.6);
      ctx.quadraticCurveTo(wShift, 8.5, wShift + 4.1, 9.6);
      ctx.quadraticCurveTo(wShift + 3.2, 13.8, wShift, 14.3);
      ctx.quadraticCurveTo(wShift - 3.2, 13.8, wShift - 4.1, 9.6);
      ctx.closePath();
      ctx.fill();
    }
    if (s.mouthColor) {
      ctx.strokeStyle = s.mouthColor;
      ctx.lineWidth = 1.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wShift - 5.8, 16.6);
      ctx.quadraticCurveTo(wShift - 2.9, 19.6, wShift, 16.4);
      ctx.quadraticCurveTo(wShift + 2.9, 19.6, wShift + 5.8, 16.6);
      ctx.stroke();
    }

    // Whiskers
    ctx.strokeStyle = s.whiskerColor;
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'round';
    const leftLen = Math.max(8, 12 - this.faceTurnX * 0.55);
    const rightLen = Math.max(8, 12 + this.faceTurnX * 0.55);
    for (let i = 0; i < 3; i++) {
      const wy = 16 + i * 5.0;
      const slant = 2.0 + i * 1.1;
      ctx.beginPath();
      ctx.moveTo(-34 + wShift, wy);
      ctx.lineTo(-34 + wShift - leftLen, wy + slant);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(34 + wShift, wy);
      ctx.lineTo(34 + wShift + rightLen, wy + slant);
      ctx.stroke();
    }

    this.drawCustomEyes(ctx, s, wShift, -1);

    ctx.restore();
    ctx.restore();
  }

  private drawCustomEyes(ctx: CanvasRenderingContext2D, s: ResolvedSkin, cx: number, eyeY: number): void {
    const blinkVal = this.isBlinking ? 1 - Math.abs(this.blinkProgress - 1) : 0;
    const closedness = Math.max(blinkVal, this.squintAmount * 0.85, this.privacyClose);
    const eyeXs = [cx - 23.0, cx + 23.0];
    const rx = 14.8 + this.typingHunch * 1.0;
    const ry = 13.4 - this.typingHunch * 0.5;

    for (let idx = 0; idx < 2; idx++) {
      ctx.save();
      ctx.translate(eyeXs[idx], eyeY);

      if (this.privacyClose > 0.45) {
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 5.2, 13.5, -0.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.squintAmount > 0.38 && blinkVal < 0.3) {
        if (s.squintGlowColor) {
          ctx.strokeStyle = s.squintGlowColor;
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-12.5, 0.2);
          ctx.quadraticCurveTo(0, 2.2, 12.5, 1.8);
          ctx.stroke();
        }
        ctx.strokeStyle = s.squintColor;
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-13.5, -0.5);
        ctx.quadraticCurveTo(0, 1.4, 13.5, 1.2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const openRy = Math.max(1.2, ry * (1 - closedness));
      const curiousTilt = (idx === 0 ? -0.1 : 0.1) * (0.25 + this.typingHunch * 0.75);
      ctx.rotate(curiousTilt);

      const irisGrad = ctx.createLinearGradient(0, -openRy, 0, openRy);
      irisGrad.addColorStop(0.0, s.eyeColorTop);
      irisGrad.addColorStop(1.0, s.eyeColorBottom);
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.clip();
      if (openRy > 3.2) {
        const px = this.eyeLookX;
        const py = this.eyeLookY;
        ctx.fillStyle = s.pupilColor;
        ctx.beginPath();
        ctx.ellipse(px, py, 6.2, 8.8, 0, 0, Math.PI * 2);
        ctx.fill();

        if (s.eyeCatchlight) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.beginPath();
          ctx.arc(px - 3.6, py - 4.0, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.beginPath();
          ctx.arc(px + 3.2, py + 3.2, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      if (s.eyeRimColor && openRy > 2.2) {
        ctx.strokeStyle = s.eyeRimColor;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, openRy, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private drawCustomIdleLegDetails(
    ctx: CanvasRenderingContext2D,
    s: ResolvedSkin,
    paw: PawState,
    topSp: Vec2,
    midSp: Vec2,
    botSp: Vec2,
    sign: -1 | 1,
    outerTopX: number,
    outerBotX: number,
    innerTopX: number,
    innerBotX: number,
  ): void {
    const armPart = paw.side === 'left' ? 'leftArm' : 'rightArm';
    for (const sp of s.spots) {
      if (sp.part !== armPart) continue;
      ctx.save();
      ctx.globalAlpha *= sp.opacity ?? 0.82;
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.ellipse(midSp.x + sign * 21, midSp.y + (sp.x - 0.5) * 28, Math.max(3, sp.rx * 0.8), Math.max(3, sp.ry * 1.1), 0.2 * sign, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Optional cute white mittens at the bottom of idle seated legs when pawColor differs from furColor!
    if (s.pawColor !== s.furColor) {
      ctx.save();
      ctx.fillStyle = s.pawColor;
      ctx.beginPath();
      ctx.ellipse(botSp.x + sign * 22, botSp.y - 4, 13.5, 9.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = s.legLineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(outerTopX, topSp.y);
    ctx.quadraticCurveTo(midSp.x + sign * 41, midSp.y, outerBotX, botSp.y - 1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(innerTopX, topSp.y + 10);
    ctx.lineTo(innerBotX, botSp.y - 1);
    ctx.stroke();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  private trapezoidPath(
    ctx: CanvasRenderingContext2D,
    topHalfW: number,
    botHalfW: number,
    topY: number,
    botY: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(-topHalfW + r, topY);
    ctx.lineTo(topHalfW - r, topY);
    ctx.quadraticCurveTo(topHalfW, topY, topHalfW + 1, topY + r);
    ctx.lineTo(botHalfW, botY - r);
    ctx.quadraticCurveTo(botHalfW, botY, botHalfW - r, botY);
    ctx.lineTo(-botHalfW + r, botY);
    ctx.quadraticCurveTo(-botHalfW, botY, -botHalfW, botY - r);
    ctx.lineTo(-topHalfW - 1, topY + r);
    ctx.quadraticCurveTo(-topHalfW, topY, -topHalfW + r, topY);
    ctx.closePath();
  }
}
