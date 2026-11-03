/** What the API's activity log says, and how the console words it. */
export interface ActivityActor {
  kind: 'admin' | 'token' | 'ci';
  name: string;
  scope?: string;
  /** The one app a deploy key belongs to */
  app?: string;
}

export interface ActivityEvent {
  id: number;
  at: string;
  actor: ActivityActor;
  action: string;
  target: string | null;
  outcome: 'ok' | 'failed';
  status: number;
  summary: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** The cursor for the next, older page; null at the end */
  next: number | null;
  actors: string[];
}

export interface ActivityFilters {
  app?: string;
  action?: string;
  actor?: string;
  outcome?: 'ok' | 'failed';
}

/** The filter on what kind of thing changed: the first word of an action. */
export const ACTION_GROUPS: { id: string; label: string }[] = [
  { id: 'app', label: 'Apps' },
  { id: 'secret', label: 'Secrets' },
  { id: 'project', label: 'Projects' },
  { id: 'group', label: 'Collections' },
  { id: 'ci-key', label: 'Deploy keys' },
  { id: 'token', label: 'Access tokens' },
  { id: 'registry', label: 'Image registries' },
  { id: 'template-source', label: 'Template registries' },
  { id: 'platform', label: 'Platform settings' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'cluster', label: 'Servers' },
  { id: 'storage', label: 'Storage' },
  { id: 'auth', label: 'Password' },
];

/** What was done, as the verb that follows the actor ("deployed"), and what it was done to. */
const WORDS: Record<string, string> = {
  'app.create': 'created the app',
  'app.delete': 'deleted the app',
  'app.deploy': 'deployed',
  'app.rename': 'renamed',
  'app.restart': 'restarted',
  'app.start': 'started',
  'app.stop': 'stopped',
  'app.scale': 'scaled',
  'app.reconcile': 'reconciled',
  'app.release-pin': 'released the machine pin of',
  'app.update': 'changed the settings of',
  'app.env.update': 'changed the variables of',
  'app.domains.update': 'changed the domains of',
  'app.network.update': 'changed the networking of',
  'app.password.update': 'changed the password protection of',
  'app.storage.update': 'changed the storage of',
  'app.storage.migrate': 'moved the data of',
  'app.storage.release': 'released the data pin of',
  'app.runtime.update': 'changed how it runs:',
  'app.move': 'moved to another collection:',
  'secret.set': 'set a secret on',
  'secret.delete': 'removed a secret from',
  'group.create': 'created the collection',
  'group.update': 'renamed the collection',
  'group.delete': 'deleted the collection',
  'project.create': 'created the project',
  'project.update': 'changed the project',
  'project.delete': 'deleted the project',
  'project.service.add': 'added a service to the project',
  'project.template.add': 'added a template to the project',
  'ci-key.create': 'made a deploy key for',
  'ci-key.delete': 'deleted a deploy key',
  'token.create': 'made the access token',
  'token.delete': 'deleted an access token',
  'auth.password.change': 'changed the console password',
  'registry.add': 'added the registry login',
  'registry.update': 'changed a registry login',
  'registry.delete': 'removed a registry login',
  'registry.signin.set': 'signed in to the registry',
  'platform.domain.set': 'set the platform domain',
  'platform.apps-domain.set': 'set the apps domain',
  'platform.https.enable': 'turned on HTTPS for the platform',
  'platform.app-defaults.set': 'changed the defaults for new apps',
  'platform.acme-email.set': 'set the certificate email',
  'platform.placeholder-page.set': 'changed the placeholder page',
  'platform.error-pages.set': 'changed the error pages',
  'platform.blueprint.set': 'applied a blueprint',
  'platform.update': 'updated the platform',
  'cluster.join-token.rotate': 'rotated the join token',
  'cluster.node.update': 'changed a server',
  'cluster.node.delete': 'removed a server',
  'notifications.webhook.add': 'added a notification webhook',
  'notifications.webhook.delete': 'removed a notification webhook',
  'notifications.events.set': 'changed which events notify',
  'notifications.sync.set': 'changed notification sync',
  'template-source.add': 'added the template registry',
  'template-source.delete': 'removed a template registry',
  'template-source.refresh': 'refreshed a template registry',
  'template-source.sync': 'changed the template registries kept by the hub',
  'storage.images.delete': 'deleted unused images',
  'storage.images.prune-unused': 'pruned unused images',
  'storage.volumes.delete': 'deleted volumes',
};

/** An action nobody wrote words for, made readable: "widgets.frobnicate" -> "widgets frobnicate". */
const humanize = (action: string) => action.replace(/[.-]/g, ' ');

export interface EventWords {
  /** "deployed", "set a secret on" */
  verb: string;
  /** Where the target links to; null when it is not a page (a deleted thing, a platform setting) */
  href: string | null;
}

/** What the target of an event is, and where it lives. */
function targetHref(action: string, target: string | null): string | null {
  if (!target) return null;
  const kind = action.split('.')[0];
  // gone (a deleted thing, or an app under the name it had before it was renamed), or never a page of its own
  if (action === 'app.rename') return null;
  if (/\.delete$/.test(action) && kind !== 'secret' && kind !== 'ci-key')
    return null;
  if (action === 'app.create' || action === 'ci-key.create')
    return `/apps/${encodeURIComponent(target)}`;
  switch (kind) {
    case 'app':
    case 'secret':
    case 'ci-key':
      return `/apps/${encodeURIComponent(target)}`;
    case 'group':
      return `/collections/${encodeURIComponent(target)}`;
    case 'project':
      return `/projects/${encodeURIComponent(target)}`;
    default:
      return null;
  }
}

export function wordsFor(
  e: Pick<ActivityEvent, 'action' | 'target'>,
): EventWords {
  return {
    verb: WORDS[e.action] ?? humanize(e.action),
    href: targetHref(e.action, e.target),
  };
}

/** The name an app has now, for a rename event: the target is the name it had. */
export function renamedTo(
  e: Pick<ActivityEvent, 'action' | 'summary'>,
): string | null {
  if (e.action !== 'app.rename') return null;
  const m = /^to (\S+)$/.exec(e.summary.trim());
  return m ? m[1] : null;
}

/** A line of detail beside the sentence, or nothing. Never the whole thing twice: a rename says "to x" already. */
export const detailOf = (e: ActivityEvent): string => e.summary.trim();

/** What a failed event says, in a few words. */
export function failureText(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'Refused: invalid';
    case 403:
      return 'Refused: not allowed';
    case 404:
      return 'Failed: not found';
    case 409:
      return 'Failed: conflict';
    default:
      return status >= 500 ? 'Failed: server error' : `Failed (${status})`;
  }
}

/** The query string for a request to the API or the console's own route. Empty filters are left out. */
export function activityQuery(
  f: ActivityFilters,
  extra: { before?: number | null; limit?: number } = {},
): string {
  const q = new URLSearchParams();
  if (f.app) q.set('app', f.app);
  if (f.action) q.set('action', f.action);
  if (f.actor) q.set('actor', f.actor);
  if (f.outcome) q.set('outcome', f.outcome);
  if (extra.before) q.set('before', String(extra.before));
  if (extra.limit) q.set('limit', String(extra.limit));
  return q.toString();
}

/** Filters out of a page's search params, leaving out anything that is not one of ours. */
export function filtersFrom(
  params: Record<string, string | string[] | undefined>,
): ActivityFilters {
  const one = (k: string) => {
    const v = params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim().slice(0, 80) : undefined;
  };
  const action = one('action');
  const outcome = one('outcome');
  return {
    app: one('app'),
    action: action && /^[a-z0-9.-]+$/.test(action) ? action : undefined,
    actor: one('actor'),
    outcome: outcome === 'ok' || outcome === 'failed' ? outcome : undefined,
  };
}

/** Events under a heading for their day: "Today", "Yesterday", then "Tuesday 4 March". */
export function groupByDay(
  events: ActivityEvent[],
  now = new Date(),
): { label: string; events: ActivityEvent[] }[] {
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86_400_000));
  const groups: { key: string; label: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const d = new Date(e.at);
    const key = day(d);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = {
        key,
        label:
          key === today
            ? 'Today'
            : key === yesterday
              ? 'Yesterday'
              : d.toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  ...(d.getFullYear() === now.getFullYear()
                    ? {}
                    : { year: 'numeric' }),
                }),
        events: [],
      };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups.map(({ label, events }) => ({ label, events }));
}

/** How many events the last day holds, for the Settings overview: "12 changes today", "200+" at the page size. */
export function todayText(count: number, limit: number): string {
  if (count === 0) return 'No changes in the last day';
  const n = count >= limit ? `${limit}+` : String(count);
  return `${n} ${count === 1 ? 'change' : 'changes'} in the last day`;
}
