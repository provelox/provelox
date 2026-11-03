/**
 * What a state-changing request means, in words, for the activity log. Pure, so every route can be tested without a
 * server.
 *
 * Nothing is taken from a body unless it is named here: the summary of each action is built from a short list of fields
 * that are safe to keep (an image tag, a variable's NAME, a host name), never from the body as a whole. A route that is
 * not listed gets an action derived from its path and no summary at all, so a new route can never put a value in the log
 * by accident.
 */
export interface Described {
  /** `app.deploy`, `domain.add`, `secret.set`: the group before the first dot is what the console filters on */
  action: string;
  /** The app, collection, project or other named thing it was about, when the route names one */
  target: string | null;
  /** A short safe line: what changed, never a value */
  summary: string;
}

/** Routes that only ask a question or try something out: not changes, so not events. */
const NOT_CHANGES = new Set([
  'POST /auth/login',
  'POST /projects/preview',
  'POST /registries/check',
  'POST /system/image-updates/check',
  'POST /system/notifications/webhooks/:id/test',
]);

const MAX_ITEMS = 8;
const MAX_TEXT = 160;

const text = (v: unknown, max = MAX_TEXT): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** "a, b, c and 2 more" */
function list(items: string[]): string {
  const shown = items.filter(Boolean).slice(0, MAX_ITEMS);
  const more = items.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/** The host of an address: a URL can carry a token in its path or query, so only the host is kept. */
function hostOf(v: unknown): string {
  const s = text(v, 400);
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).host;
  } catch {
    return '';
  }
}

/** Only the part after the @ of an address: enough to see which account, not who. */
const emailDomain = (v: unknown) => text(v, 254).split('@')[1] ?? '';

/** The tag or digest of an image reference, or the whole reference when it has neither. */
const image = (v: unknown) => text(v, 200);

const names = (rows: unknown, key: string): string[] =>
  Array.isArray(rows)
    ? rows.map((r) => text(obj(r)[key], 80)).filter(Boolean)
    : [];

/** Which families of an app's settings a PATCH touches, and the safe detail of each. */
function describeAppPatch(body: unknown): { action: string; summary: string } {
  const b = obj(body);
  const parts: { family: string; detail: string }[] = [];
  const add = (family: string, detail: string) =>
    parts.push({ family, detail });

  for (const [key, value] of Object.entries(b)) {
    switch (key) {
      case 'env': {
        const vars = names(value, 'key');
        add('env', `variables: ${list(vars) || 'none'} (${vars.length})`);
        break;
      }
      case 'domains':
        add('domains', `domains: ${list(names(value, 'host')) || 'none'}`);
        break;
      case 'primaryDomain':
        add('domains', `primary domain: ${text(value, 253) || 'none'}`);
        break;
      case 'linkedDomain':
        add('domains', `linked domain: ${text(value, 253) || 'none'}`);
        break;
      case 'forceSsl':
      case 'defaultSubdomain':
      case 'defaultSubdomainSsl':
        add('domains', `${key}: ${value === true ? 'on' : 'off'}`);
        break;
      case 'aliases': {
        const a = Array.isArray(value) ? value.map((x) => text(x, 80)) : [];
        add('network', `other names: ${list(a) || 'none'}`);
        break;
      }
      case 'ports':
      case 'pendingPorts': {
        const p = Array.isArray(value)
          ? value.map(
              (x) =>
                `${text(obj(x).hostPort, 6)}→${text(obj(x).containerPort, 6)}`,
            )
          : [];
        add(
          'network',
          `${key === 'ports' ? 'ports' : 'ports to apply'}: ${list(p) || 'none'}`,
        );
        break;
      }
      case 'containerPort':
        add('network', `container port: ${Number(value) || ''}`);
        break;
      case 'exposed':
        add('network', `web access: ${value === true ? 'on' : 'off'}`);
        break;
      case 'basicAuth': {
        const users = names(obj(value).users, 'name');
        add(
          'password',
          value === null
            ? 'password protection removed'
            : `password protection users: ${list(users) || 'none'}`,
        );
        break;
      }
      case 'cdn': {
        const c = obj(value);
        add(
          'network',
          value === null
            ? 'no longer behind a CDN'
            : `behind ${text(c.provider, 32)}${c.enforce === true ? ', only it may reach the app' : ''}`,
        );
        break;
      }
      case 'sso': {
        const c = obj(value);
        add(
          'password',
          value === null
            ? 'sign-in removed'
            : `sign-in with ${text(c.provider, 32)}`,
        );
        break;
      }
      case 'groupId':
        add('move', 'collection changed');
        break;
      case 'volumes':
        add('storage', `storage mounts: ${names(value, 'path').length || ''}`);
        break;
      case 'instanceCount':
        add('runtime', `instances: ${Number(value)}`);
        break;
      default:
        // Anything else is named, never shown: its value may be anything
        add('runtime', key);
    }
  }
  const families = [...new Set(parts.map((p) => p.family))];
  return {
    action: families.length === 1 ? `app.${families[0]}.update` : 'app.update',
    summary: parts
      .map((p) => p.detail)
      .join('; ')
      .slice(0, 400),
  };
}

const KINDS: Record<string, string> = {
  apps: 'app',
  groups: 'group',
  projects: 'project',
  registries: 'registry',
  'ci-keys': 'ci-key',
  templates: 'template',
};

/** The action a route gets when nothing above names it: the thing, then what the method means. */
function derive(method: string, route: string): string {
  const segs = route.split('/').filter((s) => s && !s.startsWith(':'));
  const kind = KINDS[segs[0]] ?? segs[0] ?? 'request';
  const rest = segs.slice(1);
  const verb =
    method === 'DELETE'
      ? 'delete'
      : method === 'POST' && rest.length === 0
        ? 'create'
        : method === 'POST'
          ? rest.join('.')
          : method === 'PATCH'
            ? [...rest, 'update'].join('.')
            : [...rest, 'set'].join('.');
  return `${kind}.${verb}`.replace(/\.$/, '');
}

/** What a request that passed the checks and changed something (or tried to) means. Null when it is not a change. */
export function describeRequest(
  method: string,
  route: string,
  params: Record<string, string | undefined>,
  body: unknown,
): Described | null {
  const key = `${method} ${route}`;
  if (NOT_CHANGES.has(key)) return null;
  const b = obj(body);
  const p = params;
  const at = (
    action: string,
    target: string | null,
    summary = '',
  ): Described => ({
    action,
    target: target || null,
    summary,
  });

  switch (key) {
    case 'POST /apps':
      return at('app.create', text(b.name, 80), '');
    case 'PATCH /apps/:name': {
      const d = describeAppPatch(body);
      return at(d.action, p.name ?? null, d.summary);
    }
    case 'DELETE /apps/:name':
      return at('app.delete', p.name ?? null);
    case 'POST /apps/:name/deploy':
      return at('app.deploy', p.name ?? null, image(b.image));
    case 'POST /apps/:name/rename':
      return at('app.rename', p.name ?? null, `to ${text(b.name, 80)}`.trim());
    case 'POST /apps/:name/restart':
    case 'POST /apps/:name/start':
    case 'POST /apps/:name/stop':
    case 'POST /apps/:name/reconcile':
    case 'POST /apps/:name/release-pin':
      return at(`app.${route.split('/').pop()}`, p.name ?? null);
    case 'POST /apps/:name/scale':
      return at(
        'app.scale',
        p.name ?? null,
        `instances: ${Number(b.instances) || ''}`,
      );
    case 'PUT /apps/:name/secrets/:secret':
      // The name of the secret, never what it holds
      return at('secret.set', p.name ?? null, text(p.secret, 80));
    case 'DELETE /apps/:name/secrets/:secret':
      return at('secret.delete', p.name ?? null, text(p.secret, 80));
    case 'POST /apps/:name/volumes/migrate':
      return at('app.storage.migrate', p.name ?? null);
    case 'POST /apps/:name/volumes/migration/release':
      return at('app.storage.release', p.name ?? null);
    case 'POST /groups':
      return at('group.create', text(b.name, 80));
    case 'PATCH /groups/:id':
      return at('group.update', p.id ?? null, text(b.name, 80));
    case 'DELETE /groups/:id':
      return at('group.delete', p.id ?? null);
    case 'POST /projects':
      return at('project.create', text(b.name, 80));
    case 'PUT /projects/:name':
      return at('project.update', p.name ?? null);
    case 'DELETE /projects/:name':
      return at('project.delete', p.name ?? null);
    case 'POST /projects/:name/add-service':
      return at('project.service.add', p.name ?? null, text(b.name, 80));
    case 'POST /projects/:name/add-template':
      return at(
        'project.template.add',
        p.name ?? null,
        text(
          typeof b.template === 'string' ? b.template : obj(b.template).id,
          80,
        ),
      );
    case 'POST /ci-keys':
      // The key's own name and the app it can deploy; never the key
      return at('ci-key.create', text(b.app, 80), text(b.name, 80));
    case 'DELETE /ci-keys/:id':
      return at('ci-key.delete', null, text(p.id, 40));
    case 'POST /ci/deploy':
      return at('app.deploy', null, image(b.image));
    case 'POST /system/access-tokens':
      return at(
        'token.create',
        null,
        `${text(b.name, 80)} (${text(b.scope, 16)})`,
      );
    case 'DELETE /system/access-tokens/:id':
      return at('token.delete', null, text(p.id, 40));
    case 'POST /auth/change-password':
      return at('auth.password.change', null);
    case 'POST /registries':
      // Which registry and which account, never the password
      return at('registry.add', text(b.domain, 120), text(b.username, 80));
    case 'PATCH /registries/:id':
      return at('registry.update', null, text(p.id, 40));
    case 'DELETE /registries/:id':
      return at('registry.delete', null, text(p.id, 40));
    case 'PUT /registries/signin':
      return at(
        'registry.signin.set',
        text(b.domain, 120),
        text(b.username, 80),
      );
    case 'PUT /system/domain':
      return at('platform.domain.set', null, text(b.rootDomain, 200));
    case 'PUT /system/apps-domain':
      return at('platform.apps-domain.set', null, text(b.appsDomain, 200));
    case 'PUT /system/platform-https':
      return at('platform.https.enable', null);
    case 'PUT /system/app-defaults':
      return at(
        'platform.app-defaults.set',
        null,
        Object.keys(b).slice(0, 6).join(', '),
      );
    case 'PUT /system/acme-email':
      return at(
        'platform.acme-email.set',
        null,
        `account at ${emailDomain(b.email)}`.trim(),
      );
    case 'PUT /system/placeholder-page':
    case 'PUT /system/error-pages':
    case 'PUT /system/blueprint':
      return at(derive(method, route).replace(/^system\./, 'platform.'), null);
    case 'POST /system/update':
      return at('platform.update', null, text(b.version, 40));
    case 'POST /system/cluster/join/rotate':
      return at('cluster.join-token.rotate', null);
    case 'PATCH /system/cluster/nodes/:id':
      return at('cluster.node.update', null, text(p.id, 40));
    case 'DELETE /system/cluster/nodes/:id':
      return at('cluster.node.delete', null, text(p.id, 40));
    case 'POST /system/notifications/webhooks':
      // Webhook addresses often carry a secret in their path: the host only
      return at('notifications.webhook.add', null, hostOf(b.url));
    case 'DELETE /system/notifications/webhooks/:id':
      return at('notifications.webhook.delete', null, text(p.id, 40));
    case 'PUT /system/notifications/events':
    case 'PUT /system/notifications/sync':
      return at(derive(method, route).replace(/^system\./, ''), null);
    case 'POST /templates/sources':
      return at('template-source.add', null, hostOf(b.url));
    case 'DELETE /templates/sources/:id':
      return at('template-source.delete', null, text(p.id, 40));
    case 'POST /templates/sources/:id/refresh':
      return at('template-source.refresh', null, text(p.id, 40));
    case 'PUT /templates/sources/sync':
      return at('template-source.sync', null);
    case 'POST /system/storage/images/delete':
    case 'POST /system/storage/images/prune-unused':
    case 'POST /system/storage/volumes/delete':
      return at(
        route.replace('/system/storage/', 'storage.').replace(/\//g, '.'),
        null,
        Array.isArray(b.names) ? `${b.names.length} item(s)` : '',
      );
    default:
      // Not named above: an action from the path, and nothing from the body
      return at(derive(method, route), text(p.name ?? p.id, 80) || null);
  }
}

/** The filter group of an action: what comes before the first dot ("app", "secret", "platform"). */
export const actionGroup = (action: string) => action.split('.')[0];
