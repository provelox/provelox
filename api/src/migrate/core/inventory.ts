import type { AppClass, SourceApp } from './source';

export interface InventoryEntry {
  app: SourceApp;
  class: AppClass;
}

export interface Inventory {
  apps: InventoryEntry[];
  counts: Record<AppClass, number>;
}

export function classify(a: SourceApp): AppClass {
  if (a.blocker || a.attention.length > 0 || a.hostPorts.length > 0)
    return 'needs-attention';
  return a.persistent ? 'has-data' : 'ready';
}

export function inventory(apps: SourceApp[]): Inventory {
  const entries = [...apps]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((app) => ({ app, class: classify(app) }));
  const counts: Record<AppClass, number> = {
    ready: 0,
    'has-data': 0,
    'needs-attention': 0,
  };
  for (const e of entries) counts[e.class]++;
  return { apps: entries, counts };
}

const uniquePorts = (a: SourceApp) => [
  ...new Set(a.hostPorts.map((p) => p.hostPort)),
];

/** The report the `inventory` command prints. Environment variable values are never shown. */
export function formatInventory(inv: Inventory): string {
  const lines: string[] = [];
  for (const { app: a, class: cls } of inv.apps) {
    lines.push(`${a.name}  [${cls}]`);
    lines.push(`  image      ${a.image || '(none deployed)'}`);
    lines.push(
      `  runs as    ${a.instanceCount} instance${a.instanceCount === 1 ? '' : 's'}, port ${a.containerPort}${a.exposed ? '' : ', not exposed'}${a.forceSsl ? ', force HTTPS' : ''}`,
    );
    if (a.domains.length)
      lines.push(
        `  domains    ${a.domains.map((d) => d.host + (d.ssl ? ' (https)' : '')).join(', ')}`,
      );
    if (a.env.length)
      lines.push(`  env        ${a.env.map((e) => e.key).join(', ')}`);
    for (const v of a.volumes)
      lines.push(`  volume     ${v.volume ?? v.hostPath} → ${v.containerPath}`);
    for (const p of a.hostPorts)
      lines.push(
        `  host port  ${p.hostPort} → ${p.containerPort}/${p.protocol}`,
      );
    if (a.hostPorts.length)
      lines.push(
        `  ! Publishes host port${uniquePorts(a).length > 1 ? 's' : ''} ${uniquePorts(a).join(', ')}: imported stopped, because only one platform can hold a port until cutover.`,
      );
    if (a.blocker) lines.push(`  ✗ ${a.blocker}`);
    for (const t of a.attention) lines.push(`  ! ${t}`);
    for (const t of a.warnings) lines.push(`  ! ${t}`);
    for (const t of a.notes) lines.push(`  · ${t}`);
    lines.push('');
  }
  const c = inv.counts;
  lines.push(
    `${inv.apps.length} app${inv.apps.length === 1 ? '' : 's'}: ${c.ready} ready, ${c['has-data']} with data, ${c['needs-attention']} need attention.`,
  );
  return lines.join('\n');
}

/** The same report as data, for `--json`: no variable values. */
export function inventoryJson(inv: Inventory) {
  return {
    counts: inv.counts,
    apps: inv.apps.map(({ app, class: cls }) => ({
      ...app,
      class: cls,
      env: app.env.map((e) => e.key),
    })),
  };
}

export { uniquePorts };
