import {
  Bell,
  Boxes,
  CircleArrowUp,
  FileText,
  Globe,
  HardDrive,
  History,
  KeyRound,
  LayoutTemplate,
  Package,
  Palette,
  Plug,
  Server,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  keywords?: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/** The main places: the sidebar and the command palette's "Pages" section list them. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'apps', label: 'Apps', href: '/apps', icon: Boxes },
      {
        id: 'templates',
        label: 'Templates',
        href: '/templates',
        icon: LayoutTemplate,
        keywords: [
          'one click',
          'ready made',
          'postgres',
          'redis',
          'wordpress',
          'database',
          'catalog',
        ],
      },
    ],
  },
];

export interface SettingsPage {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** One sentence for the Settings overview */
  description: string;
  /** Other words that should find it in the palette */
  keywords: string[];
}

export interface SettingsGroup {
  id: string;
  label: string;
  pages: SettingsPage[];
}

/**
 * The platform's settings, one topic to a page, in groups. Settings is its own area with this list on its left, and an
 * overview that says where each thing stands.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'general',
    label: 'General',
    pages: [
      {
        id: 'appearance',
        label: 'Appearance',
        href: '/settings/appearance',
        icon: Palette,
        description: 'Light, dark, or follow your device.',
        keywords: ['theme', 'dark mode', 'light mode', 'system'],
      },
      {
        id: 'domain',
        label: 'Domain & HTTPS',
        href: '/settings/domain',
        icon: Globe,
        description: 'Where apps are served, and the certificate email.',
        keywords: [
          'root domain',
          'ssl',
          'certificate',
          'default address',
          'lets encrypt',
        ],
      },
      {
        id: 'notifications',
        label: 'Notifications',
        href: '/settings/notifications',
        icon: Bell,
        description: 'Get told when an app or server has a problem.',
        keywords: ['webhook', 'slack', 'discord', 'alert', 'email'],
      },
      {
        id: 'platform-pages',
        label: 'Platform pages',
        href: '/settings/platform-pages',
        icon: FileText,
        description:
          'What visitors see before an app is deployed, or when it is down.',
        keywords: ['placeholder', 'error page', '502', '503'],
      },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    pages: [
      {
        id: 'access',
        label: 'Password & tokens',
        href: '/settings/access',
        icon: ShieldCheck,
        description: 'The console password, and tokens for other systems.',
        keywords: [
          'security',
          'change password',
          'access token',
          'hub',
          'read only',
        ],
      },
      {
        id: 'deploy-keys',
        label: 'Deploy keys',
        href: '/settings/deploy-keys',
        icon: KeyRound,
        description:
          'Keys for CI, each able to deploy one app and nothing else.',
        keywords: ['ci', 'github actions', 'api key', 'token', 'pipeline'],
      },
      {
        id: 'activity',
        label: 'Activity',
        href: '/settings/activity',
        icon: History,
        description: 'Who changed what, and when.',
        keywords: ['audit', 'log', 'history', 'events', 'who', 'changes'],
      },
      {
        id: 'security-checks',
        label: 'Security checks',
        href: '/settings/security-checks',
        icon: ShieldAlert,
        description:
          'Looks for the signs of a break-in: open databases, a hidden miner, malware left on the machine.',
        keywords: [
          'malware',
          'miner',
          'cryptominer',
          'hacked',
          'compromised',
          'rootkit',
          'ssh',
          'open port',
          'scan',
        ],
      },
    ],
  },
  {
    id: 'sources',
    label: 'Sources',
    pages: [
      {
        id: 'registries',
        label: 'Image registries',
        href: '/settings/registries',
        icon: Package,
        description: 'Logins for the registries your private images come from.',
        keywords: [
          'docker',
          'ghcr',
          'github',
          'gitlab',
          'ecr',
          'pull',
          'private image',
        ],
      },
      {
        id: 'template-registries',
        label: 'Template registries',
        href: '/settings/template-registries',
        icon: LayoutTemplate,
        description: 'Your own templates, next to the built-in ones.',
        keywords: ['templates', 'catalog', 'git', 'index', 'one click'],
      },
    ],
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    pages: [
      {
        id: 'servers',
        label: 'Servers',
        href: '/settings/servers',
        icon: Server,
        description: 'The machines in the cluster, and adding more.',
        keywords: ['nodes', 'swarm', 'cluster', 'join', 'drain'],
      },
      {
        id: 'updates',
        label: 'Updates',
        href: '/settings/updates',
        icon: CircleArrowUp,
        description:
          'Which release this server runs and whether a newer one is out. An update never starts by itself.',
        keywords: [
          'update',
          'upgrade',
          'release',
          'version',
          'new version',
          'self-update',
          'latest',
        ],
      },
      {
        id: 'platform-services',
        label: 'Platform services',
        href: '/settings/platform-services',
        icon: Boxes,
        description: 'The proxy, API and console that run Provelox itself.',
        keywords: ['proxy', 'traefik', 'update', 'restart'],
      },
      {
        id: 'storage',
        label: 'Storage & cleanup',
        href: '/settings/storage',
        icon: HardDrive,
        description: 'Disk used by images and volumes, and what can go.',
        keywords: ['disk', 'volumes', 'images', 'prune', 'space'],
      },
      {
        id: 'connection',
        label: 'Connection',
        href: '/settings/connection',
        icon: Plug,
        description: 'How the console reaches the API, read only.',
        keywords: ['api', 'docker', 'status', 'session'],
      },
    ],
  },
];

export const SETTINGS_PAGES: SettingsPage[] = SETTINGS_GROUPS.flatMap(
  (g) => g.pages,
);

/** A page of an app, with the sections it holds: what the app's left rail lists. */
export interface AppNavItem {
  /** Appended to /apps/<name> */
  href: string;
  label: string;
  /** `keywords` are other words someone might search for it by (the command palette uses them) */
  sections: {
    id: string;
    label: string;
    count?: number;
    keywords?: string[];
  }[];
}

/** How many entries each countable section holds, for the rail. */
export interface AppNavCounts {
  env?: number;
  secrets?: number;
  volumes?: number;
  domains?: number;
  ports?: number;
}

/** Everything about an app in one list: its pages, and under each page the sections it scrolls through. */
export function appNav(c: AppNavCounts = {}): AppNavItem[] {
  return [
    { href: '', label: 'Overview', sections: [] },
    {
      href: '/deploy',
      label: 'Deployments',
      // one short page: nothing to scroll between, so no sub-list (its sections still have anchors for links)
      sections: [],
    },
    {
      href: '/configuration',
      label: 'Configuration',
      sections: [
        {
          id: 'environment',
          label: 'Environment',
          count: c.env,
          keywords: ['env', 'variables', 'dotenv', 'config'],
        },
        {
          id: 'secrets',
          label: 'Secrets',
          count: c.secrets,
          keywords: ['password', 'token', 'key', 'credentials'],
        },
        {
          id: 'storage',
          label: 'Storage',
          count: c.volumes,
          keywords: ['volume', 'disk', 'mount', 'data', 'bind'],
        },
        {
          id: 'runtime',
          label: 'Process & limits',
          keywords: [
            'cpu',
            'memory',
            'limit',
            'command',
            'entrypoint',
            'healthcheck',
            'restart',
          ],
        },
        {
          id: 'placement',
          label: 'Where it runs',
          keywords: ['node', 'server', 'worker', 'manager', 'constraint'],
        },
      ],
    },
    {
      href: '/networking',
      label: 'Networking',
      sections: [
        {
          id: 'web',
          label: 'Web access',
          keywords: ['http', 'expose', 'public', 'website'],
        },
        {
          id: 'domains',
          label: 'Domains & HTTPS',
          count: c.domains,
          keywords: ['dns', 'ssl', 'tls', 'certificate', 'address', 'hostname'],
        },
        {
          id: 'sso',
          label: 'Sign in with…',
          keywords: [
            'sign in',
            'signin',
            'sso',
            'oauth',
            'oidc',
            'openid',
            'google',
            'github',
            'okta',
            'microsoft',
            'login',
            'authentication',
          ],
        },
        {
          id: 'password',
          label: 'Password protection',
          keywords: ['basic auth', 'login', 'htpasswd', 'protect'],
        },
        {
          id: 'cdn',
          label: 'CDN',
          keywords: [
            'cloudfront',
            'cloudflare',
            'fastly',
            'visitor ip',
            'proxy',
          ],
        },
        {
          id: 'ports',
          label: 'Port forwarding',
          count: c.ports,
          keywords: ['tcp', 'udp', 'publish', 'expose'],
        },
        { id: 'internal', label: 'Internal address', keywords: ['alias'] },
        {
          id: 'error-pages',
          label: 'Error pages',
          keywords: ['404', '502', '503', 'custom page'],
        },
      ],
    },
    { href: '/logs', label: 'Logs', sections: [] },
  ];
}

/** The pages alone, for the tabs on a narrow screen and the palette. */
export const APP_TABS = appNav().map(({ href, label }) => ({ href, label }));
