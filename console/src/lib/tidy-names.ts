import { collectionForProduct, suggestFromDomain } from './app-name';

/** What the proposals need about one app, from the Apps list. */
export interface TidyApp {
  name: string;
  /** The compose project it belongs to: its services are named by the project's file, so they are left alone */
  project?: string;
  /** Every host it answers on, the default address included */
  hosts: string[];
}

export interface TidyProposal {
  app: string;
  to: string;
  /** The domain the name comes from */
  host: string;
  product: string;
  role: string;
  /** The collection to move it to: only when there is exactly one that fits and it is not already in it */
  collection: { id: string; name: string } | null;
}

export interface TidySkip {
  app: string;
  reason: string;
}

/**
 * The names the convention (<product>-<role>, from the app's own domain) would give the apps you already have. The
 * first custom domain is the one it reads, since that is the one the app is known by. An app is left out, with the
 * reason, when it has no custom domain, belongs to a project, already has the name, or the name would collide with an
 * app that exists or with another proposal (both are left out: it is not for us to pick which one gets it).
 */
export function proposeTidyNames(input: {
  apps: TidyApp[];
  rootDomain: string;
  collections: { id: string; name: string; appNames: string[] }[];
}): { proposals: TidyProposal[]; skipped: TidySkip[] } {
  const taken = new Set(input.apps.map((a) => a.name));
  const skipped: TidySkip[] = [];
  const found: Omit<TidyProposal, 'collection'>[] = [];

  for (const app of input.apps) {
    if (app.project) {
      skipped.push({ app: app.name, reason: 'Part of a project' });
      continue;
    }
    const fallback = input.rootDomain ? `${app.name}.${input.rootDomain}` : '';
    const custom = app.hosts.filter((h) => h !== fallback);
    if (custom.length === 0) {
      skipped.push({ app: app.name, reason: 'No custom domain' });
      continue;
    }
    const s = custom.map((h) => suggestFromDomain(h)).find((x) => x !== null);
    if (!s) {
      skipped.push({ app: app.name, reason: 'No name fits its domain' });
      continue;
    }
    if (s.name === app.name) continue; // already tidy
    if (taken.has(s.name)) {
      skipped.push({ app: app.name, reason: `${s.name} is already an app` });
      continue;
    }
    found.push({
      app: app.name,
      to: s.name,
      host: s.host,
      product: s.product,
      role: s.role,
    });
  }

  const count = new Map<string, number>();
  for (const f of found) count.set(f.to, (count.get(f.to) ?? 0) + 1);
  const proposals: TidyProposal[] = [];
  for (const f of found) {
    if ((count.get(f.to) ?? 0) > 1) {
      skipped.push({ app: f.app, reason: `Another app would also be ${f.to}` });
      continue;
    }
    const target = collectionForProduct(f.product, input.collections);
    const already = target?.appNames.includes(f.app);
    proposals.push({
      ...f,
      collection:
        target && !already ? { id: target.id, name: target.name } : null,
    });
  }
  proposals.sort((a, b) => a.to.localeCompare(b.to));
  return { proposals, skipped };
}
