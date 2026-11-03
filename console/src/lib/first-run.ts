/**
 * The first-run checklist on an empty instance: what has been done and what is next, worked out from what the console
 * already knows (the platform's domain, its apps, its deploy keys). Pure, so the rules can be tested; the card that
 * draws it and remembers "hide this" is components/apps/first-run-card.tsx.
 */
export interface FirstRunStep {
  id: 'domain' | 'app' | 'deploy' | 'key';
  title: string;
  /** One line on why or how */
  detail: string;
  /** Where to do it */
  href: string;
  /** What the link says */
  action: string;
  done: boolean;
}

export interface FirstRunFacts {
  rootDomain: string;
  /** The Let's Encrypt email, needed before any certificate can be issued */
  acmeEmail: string;
  apps: { name: string; deployed: boolean }[];
  /** Deploy keys that exist, for any app */
  deployKeys: number;
}

export function buildChecklist(f: FirstRunFacts): FirstRunStep[] {
  const first = f.apps[0];
  const undeployed = f.apps.find((a) => !a.deployed);
  return [
    {
      id: 'domain',
      title: 'Set your domain and certificate email',
      detail:
        'Apps are served under this domain, and Let’s Encrypt needs the email to issue their certificates.',
      href: '/settings/domain',
      action: 'Open Domain & HTTPS',
      done: !!f.rootDomain && !!f.acmeEmail,
    },
    {
      id: 'app',
      title: 'Create your first app',
      detail: 'A name is enough to start; you can attach domains later.',
      href: '/apps?new=1',
      action: 'New app',
      done: f.apps.length > 0,
    },
    {
      id: 'deploy',
      title: 'Deploy an image',
      detail: 'Point it at an image tag and watch it roll out.',
      href: undeployed ? `/apps/${undeployed.name}/deploy` : '/apps?new=1',
      action: undeployed ? `Deploy to ${undeployed.name}` : 'New app',
      done: f.apps.some((a) => a.deployed),
    },
    {
      id: 'key',
      title: 'Add a deploy key for CI',
      detail:
        'A key that can deploy one app and nothing else, to use from your pipeline.',
      href: first ? `/apps/${first.name}/deploy` : '/settings/deploy-keys',
      action: first ? 'Create a key' : 'Open Deploy keys',
      done: f.deployKeys > 0,
    },
  ];
}

export const nextStep = (steps: FirstRunStep[]) =>
  steps.find((s) => !s.done) ?? null;

export const progress = (steps: FirstRunStep[]) => ({
  done: steps.filter((s) => s.done).length,
  total: steps.length,
});

/** What this browser remembers about the checklist. */
export interface FirstRunMemory {
  dismissed?: boolean;
  /** It was shown on an empty instance: it stays until it is done or hidden, even after the first app exists */
  started?: boolean;
}

/**
 * Whether to show it. An instance with no apps always starts it (unless it was hidden); one that already runs several
 * apps and never saw it is not nagged about steps it has long since decided about.
 */
export function shouldShow(opts: {
  appCount: number;
  complete: boolean;
  memory: FirstRunMemory;
}): boolean {
  if (opts.complete || opts.memory.dismissed) return false;
  return opts.appCount === 0 || !!opts.memory.started;
}
