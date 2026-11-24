import { KEYBOARD_KEYS_65, resolveKeyByVk, type KeyboardLayoutDef, type KeySpec } from './keyboardLayout';

export const DESK_KEYBOARD_WIDTH = 234;
export const DESK_KEYBOARD_DEPTH = 72;
export const POINTER_DEVICE_SCALE = 0.9;
const TRACKPAD_VISUAL_SCALE = 0.9 * POINTER_DEVICE_SCALE;
export const DESK_TRACKPAD_SLOT_WIDTH = DESK_KEYBOARD_WIDTH * 160 / 306;
export const DESK_TRACKPAD_WIDTH = DESK_TRACKPAD_SLOT_WIDTH * TRACKPAD_VISUAL_SCALE;
export const DESK_TRACKPAD_DEPTH = DESK_KEYBOARD_DEPTH * 114.9 / 110 * TRACKPAD_VISUAL_SCALE;
export const DESK_DEVICE_GAP = DESK_KEYBOARD_WIDTH * 27 / 306;
export const DESK_CENTER_Y = 355;
export const DESK_KEYS_SIDE_INSET = 5;
export const DESK_KEYS_TOP_INSET = 12;
export const DESK_KEYS_BOTTOM_INSET = 4;

const modifiedKeys: Record<string, Partial<KeySpec>> = {
  bs: { vkCodes: [0x08] },
  bslash: { vkCodes: [0xdc] },
  rshift: { uWidth: 1.75 },
  space: { uWidth: 5.5 },
  ralt: { uStart: 9.25, uWidth: 1.25, vkCodes: [0xa5] },
  left: { uStart: 13, vkCodes: [0x25] },
  down: { uStart: 14, vkCodes: [0x28] },
  up: { row: 3, uStart: 14, vkCodes: [0x26] },
  right: { uStart: 15 },
};

export const LOW_PROFILE_LAYOUT: KeyboardLayoutDef = {
  id: '65',
  totalUnits: 16,
  totalRows: 5,
  keys: [
    ...KEYBOARD_KEYS_65.map((key) => ({ ...key, ...modifiedKeys[key.id] })),
    { id: 'insert', label: 'Ins', bubble: 'Ins', row: 0, uStart: 15, uWidth: 1, vkCodes: [0x2d] },
    { id: 'delete', label: 'Del', bubble: 'Del', row: 1, uStart: 15, uWidth: 1, vkCodes: [0x2e] },
    { id: 'pageup', label: 'PgUp', bubble: 'PgUp', row: 2, uStart: 15, uWidth: 1, vkCodes: [0x21, 0x24] },
    { id: 'pagedown', label: 'PgDn', bubble: 'PgDn', row: 3, uStart: 15, uWidth: 1, vkCodes: [0x22, 0x23] },
    { id: 'fn', label: 'Fn', bubble: 'Fn', row: 4, uStart: 10.5, uWidth: 1.25, vkCodes: [] },
    { id: 'rctrl', label: 'Ctrl', bubble: 'Ctrl', row: 4, uStart: 11.75, uWidth: 1.25, vkCodes: [0xa3] },
  ],
};

const lowProfileKeysById = new Map(LOW_PROFILE_LAYOUT.keys.map((key) => [key.id, key]));
const lowProfileKeysByVk = new Map(
  LOW_PROFILE_LAYOUT.keys.flatMap((key) => key.vkCodes.map((vk) => [vk, key] as const)),
);

export function resolveLowProfileKey(vk: number): KeySpec | null {
  const direct = lowProfileKeysByVk.get(vk);
  if (direct) return direct;
  const fallback = resolveKeyByVk(vk, '65');
  return fallback ? lowProfileKeysById.get(fallback.id) ?? null : null;
}

// All objects on the desk share the same horizontal vanishing point.
// Coordinates are laid out using a common physical scale before projection.
export function projectDeskPoint(x: number, y: number, centerX: number): { x: number; y: number } {
  const scale = 1 + (y - DESK_CENTER_Y) * 0.00145;
  return { x: centerX + (x - centerX) * scale, y };
}

export function traceDeskRect(
  ctx: CanvasRenderingContext2D, centerX: number,
  left: number, top: number, width: number, depth: number, radius: number, height = 0,
): void {
  const right = left + width;
  const bottom = top + depth;
  const r = Math.min(radius, width / 2, depth / 2);
  const p = (x: number, y: number) => projectDeskPoint(x, y, centerX);
  const line = (x: number, y: number) => {
    const point = p(x, y);
    ctx.lineTo(point.x, point.y - height);
  };
  const corner = (x: number, y: number, endX: number, endY: number) => {
    const point = p(x, y);
    const end = p(endX, endY);
    ctx.quadraticCurveTo(point.x, point.y - height, end.x, end.y - height);
  };
  const start = p(left + r, top);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y - height);
  line(right - r, top);
  corner(right, top, right, top + r);
  line(right, bottom - r);
  corner(right, bottom, right - r, bottom);
  line(left + r, bottom);
  corner(left, bottom, left, bottom - r);
  line(left, top + r);
  corner(left, top, left + r, top);
  ctx.closePath();
}
