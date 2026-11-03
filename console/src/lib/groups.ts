/** Console-side folders for apps. Provelox has no such concept, so these live in the console's own data. */
export interface Group {
  id: string;
  name: string;
  appNames: string[];
}

export interface GroupsFile {
  groups: Group[];
}

export const MAX_GROUP_NAME = 40;
export const MAX_GROUPS = 100;

export class GroupError extends Error {}

export const emptyGroups = (): GroupsFile => ({ groups: [] });

export function normalizeGroupName(raw: string) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Why a group name can't be used, or null when it can. Names are unique ignoring case. */
export function explainGroupName(
  raw: string,
  file: GroupsFile,
  exceptId?: string,
): string | null {
  const name = normalizeGroupName(raw);
  if (!name) return 'Give the collection a name.';
  if (name.length > MAX_GROUP_NAME)
    return `Collection names are at most ${MAX_GROUP_NAME} characters.`;
  if (
    file.groups.some(
      (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase(),
    )
  )
    return 'A collection with that name already exists.';
  return null;
}

function check(raw: string, file: GroupsFile, exceptId?: string) {
  const problem = explainGroupName(raw, file, exceptId);
  if (problem) throw new GroupError(problem);
  return normalizeGroupName(raw);
}

export function addGroup(file: GroupsFile, id: string, rawName: string) {
  if (file.groups.length >= MAX_GROUPS)
    throw new GroupError(`You can have at most ${MAX_GROUPS} collections.`);
  const name = check(rawName, file);
  return { groups: [...file.groups, { id, name, appNames: [] }] };
}

export function renameGroup(file: GroupsFile, id: string, rawName: string) {
  if (!file.groups.some((g) => g.id === id))
    throw new GroupError('Collection not found.');
  const name = check(rawName, file, id);
  return { groups: file.groups.map((g) => (g.id === id ? { ...g, name } : g)) };
}

/** Removes the group only: its apps are no longer in a collection, nothing is deleted from Provelox. */
export function deleteGroup(file: GroupsFile, id: string) {
  if (!file.groups.some((g) => g.id === id))
    throw new GroupError('Collection not found.');
  return { groups: file.groups.filter((g) => g.id !== id) };
}

/** Puts an app in a group (or in none, with null). An app is in at most one group. */
export function assignApp(
  file: GroupsFile,
  appName: string,
  groupId: string | null,
) {
  if (groupId !== null && !file.groups.some((g) => g.id === groupId))
    throw new GroupError('Collection not found.');
  return {
    groups: file.groups.map((g) => {
      const without = g.appNames.filter((n) => n !== appName);
      return g.id === groupId
        ? { ...g, appNames: [...without, appName].sort() }
        : { ...g, appNames: without };
    }),
  };
}

export const removeApp = (file: GroupsFile, appName: string) =>
  assignApp(file, appName, null);

export const groupOfApp = (file: GroupsFile, appName: string) =>
  file.groups.find((g) => g.appNames.includes(appName));

/** Splits live apps into their groups and the rest. Names of apps that no longer exist are ignored. */
export function partition<T extends { appName: string }>(
  file: GroupsFile,
  apps: T[],
) {
  const byName = new Map(apps.map((a) => [a.appName, a]));
  const grouped = new Set<string>();
  const groups = [...file.groups]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => {
      const members = group.appNames
        .map((n) => byName.get(n))
        .filter((a): a is T => !!a);
      members.forEach((a) => grouped.add(a.appName));
      return { group, apps: members };
    });
  return { groups, ungrouped: apps.filter((a) => !grouped.has(a.appName)) };
}

/** Tolerates a hand-edited or older file: anything unexpected is dropped rather than crashing the page. */
export function parseGroupsFile(raw: unknown): GroupsFile {
  const list = (raw as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(list)) return emptyGroups();
  const seen = new Set<string>();
  const placed = new Set<string>();
  const groups: Group[] = [];
  for (const g of list) {
    if (
      !g ||
      typeof g.id !== 'string' ||
      typeof g.name !== 'string' ||
      seen.has(g.id)
    )
      continue;
    seen.add(g.id);
    groups.push({
      id: g.id,
      name: normalizeGroupName(g.name).slice(0, MAX_GROUP_NAME) || 'Group',
      // an app belongs to one group only: the first one listing it wins
      appNames: Array.isArray(g.appNames)
        ? [...new Set<string>(g.appNames)].filter(
            (n) => typeof n === 'string' && !placed.has(n) && !!placed.add(n),
          )
        : [],
    });
  }
  return { groups };
}
