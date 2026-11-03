import type { MigrationSource } from '../core/source';
import { caprover } from './caprover';

/** Every platform Provelox can migrate from. Adding one: implement `MigrationSource` in a folder here and list it. */
export const SOURCES: MigrationSource[] = [caprover];

export function findSource(id: string | undefined): MigrationSource {
  if (!id) {
    if (SOURCES.length === 1) return SOURCES[0];
    throw new Error(
      `Say which platform to migrate from with --from (${SOURCES.map((s) => s.id).join(', ')}).`,
    );
  }
  const s = SOURCES.find((x) => x.id === id);
  if (!s)
    throw new Error(
      `Unknown platform "${id}". Available: ${SOURCES.map((x) => x.id).join(', ')}.`,
    );
  return s;
}
