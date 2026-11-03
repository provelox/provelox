/** How far apart two versions are, for a tag shaped like 1.4.2. Anything else is just "newer". */
export type Kind = 'major' | 'minor' | 'patch' | 'newer';

const NUM = /\d+/g;

/** The tag with every run of digits turned into #: tags of the same shape are versions of the same kind of thing. */
export const shapeOf = (tag: string) => tag.replace(NUM, '#');

const numbersOf = (tag: string) => (tag.match(NUM) ?? []).map(Number);

/** `latest`, `alpine`, `stable`: a name that moves, with no number to compare. */
export const isFloating = (tag: string) => !/\d/.test(tag);

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether there is a version to compare: not a name that moves (`latest`), nor a bare major line (`mysql:8`). */
export function comparable(tag: string): boolean {
  if (isFloating(tag)) return false;
  return !(shapeOf(tag) === '#' && numbersOf(tag)[0] < 10_000);
}

/**
 * The newest tag of the same shape as `current` that is higher than it, or null. Shape keeps a release candidate, a
 * variant (`-alpine`) and a date tag apart from each other: `1.4.0-alpine` is only compared with `#.#.#-alpine`.
 */
export function newestTag(
  current: string,
  tags: string[],
): { tag: string; kind: Kind } | null {
  // `latest`, and `mysql:8` or `postgres:16`, which name a line someone chose to stay on: only a rebuilt tag matters
  if (!comparable(current)) return null;
  const shape = shapeOf(current);
  const mine = numbersOf(current);
  let best: { tag: string; nums: number[] } | null = null;
  for (const t of tags) {
    if (t === current || shapeOf(t) !== shape) continue;
    const nums = numbersOf(t);
    if (compare(nums, mine) <= 0) continue;
    if (!best || compare(nums, best.nums) > 0) best = { tag: t, nums };
  }
  if (!best) return null;
  return { tag: best.tag, kind: kindOf(current, mine, best.nums, shape) };
}

function kindOf(
  current: string,
  mine: number[],
  next: number[],
  shape: string,
): Kind {
  // Only a dotted version says what kind of step it is; a date or a build number is just newer
  if (!/^v?#(\.#)+/.test(shape) || /\d{5,}/.test(current)) return 'newer';
  const at = mine.findIndex((n, i) => n !== (next[i] ?? 0));
  if (at === 0) return 'major';
  if (at === 1) return 'minor';
  return 'patch';
}
