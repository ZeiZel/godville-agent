export interface ZpgWindowOptions {
  minOffsetSeconds?: number;
  maxOffsetSeconds?: number;
}

export const DEFAULT_ZPG_WINDOW: Readonly<{ minOffsetSeconds: 5; maxOffsetSeconds: 160 }> = {
  minOffsetSeconds: 5,
  maxOffsetSeconds: 160,
};

function bounds(options: ZpgWindowOptions = {}): { min: number; max: number } | undefined {
  const min = options.minOffsetSeconds ?? DEFAULT_ZPG_WINDOW.minOffsetSeconds;
  const max = options.maxOffsetSeconds ?? DEFAULT_ZPG_WINDOW.maxOffsetSeconds;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max > 160 || min > max) return undefined;
  return { min, max };
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameUtcHour(left: Date, right: Date): boolean {
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate()
    && left.getUTCHours() === right.getUTCHours();
}

/** Official ZPG entry window: a bounded offset from the start of an hour (never past 02:40). */
export function isZpgEntryWindow(date: Date, options: ZpgWindowOptions = {}): boolean {
  const range = bounds(options);
  if (!validDate(date) || !range) return false;
  const offset = date.getUTCMinutes() * 60 + date.getUTCSeconds();
  return offset >= range.min && offset <= range.max;
}

/** Physical click gate: the deadline must belong to the same hour and not be in the past. */
export function isZpgEntryWindowAtGate(now: Date, deadline: Date, options: ZpgWindowOptions = {}): boolean {
  return validDate(now) && validDate(deadline) && now.getTime() <= deadline.getTime() && sameUtcHour(now, deadline) && isZpgEntryWindow(now, options);
}
