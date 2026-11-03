'use client';

import {
  Boxes,
  CornerDownLeft,
  Library,
  Globe,
  KeyRound,
  Keyboard,
  Layers,
  LayoutTemplate,
  LogOut,
  Moon,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Pin,
  Sun,
  Variable,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { restartAppAction, updateAppAction } from '@/actions/apps';
import { useTheme } from '@/components/theme-provider';
import { useFavorites } from '@/lib/use-favorites';
import type { ShellApp } from './sidebar-apps';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { logoutAction } from '@/actions/auth';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { appNav, NAV_GROUPS, SETTINGS_GROUPS } from '@/lib/nav';
import { matches, parse, type Entry, type Section } from '@/lib/palette';
import { hintForHref } from '@/lib/shortcuts';

const SECTION_LABEL: Record<Section, string> = {
  here: 'Here',
  pages: 'Pages',
  apps: 'Apps',
  actions: 'Actions',
};
const RECENTS_KEY = 'provelox:palette:recents';
const MAX_RECENTS = 5;

function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecents(ids: string[]) {
  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(ids.slice(0, MAX_RECENTS)),
    );
  } catch {
    // storage unavailable: recents are a convenience only
  }
}

export function usePaletteOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen] as const;
}

export function CommandPalette({
  open,
  onOpenChange,
  apps,
  groups,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: ShellApp[];
  groups: { id: string; name: string }[];
  /** Opens the list of keyboard shortcuts */
  onShowShortcuts?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolved, setTheme } = useTheme();
  const { pinned, toggle: togglePinned } = useFavorites();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setQuery('');
      setRecents(readRecents());
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const g of NAV_GROUPS)
      for (const n of g.items)
        list.push({
          id: `page:${n.id}`,
          section: 'pages',
          title: n.label,
          subtitle: g.label,
          icon: n.icon,
          href: n.href,
          hint: hintForHref(n.href),
          keywords: n.keywords ?? [],
        });
    list.push({
      id: 'page:settings',
      section: 'pages',
      title: 'Settings',
      subtitle: 'Overview',
      icon: Settings,
      href: '/settings',
      hint: hintForHref('/settings'),
      keywords: ['preferences', 'configuration'],
    });
    for (const g of SETTINGS_GROUPS)
      for (const p of g.pages)
        list.push({
          id: `page:settings-${p.id}`,
          section: 'pages',
          title: `Settings · ${p.label}`,
          subtitle: g.label,
          icon: p.icon,
          href: p.href,
          keywords: ['settings', g.label, p.description, ...p.keywords],
        });
    const currentName = /^\/apps\/([^/]+)/.exec(pathname)?.[1];
    for (const a of apps) {
      list.push({
        id: `app:${a.name}`,
        section: 'apps',
        title: a.name,
        subtitle: a.group ?? 'App',
        icon: Boxes,
        href: `/apps/${a.name}`,
        keywords: a.group ? [a.group] : [],
      });
      // The app's pages, and each section on them. The app you are on has its own under Here (below); another app's are
      // found by naming it ("site oauth"), so a search for "oauth" is not buried under one row per app.
      if (a.name === currentName) continue;
      for (const page of appNav().filter((p) => p.href)) {
        list.push({
          id: `app:${a.name}${page.href}`,
          section: 'apps',
          title: `${a.name} · ${page.label}`,
          icon: Boxes,
          href: `/apps/${a.name}${page.href}`,
          keywords: [a.name, page.label, ...(a.group ? [a.group] : [])],
          searchOnly: true,
        });
        for (const s of page.sections)
          list.push({
            id: `app:${a.name}${page.href}#${s.id}`,
            section: 'apps',
            title: `${a.name} · ${s.label}`,
            subtitle: page.label,
            icon: Boxes,
            href: `/apps/${a.name}${page.href}#${s.id}`,
            keywords: [
              a.name,
              ...(s.keywords ?? []),
              ...(a.group ? [a.group] : []),
            ],
            searchOnly: true,
            scope: a.name,
          });
      }
    }
    for (const g of groups)
      list.push({
        id: `group:${g.id}`,
        section: 'apps',
        title: g.name,
        subtitle: 'Collection',
        icon: Library,
        href: `/collections/${g.id}`,
        keywords: ['group'],
      });
    for (const p of [
      ...new Set(apps.flatMap((a) => (a.project ? [a.project] : []))),
    ])
      list.push({
        id: `project:${p}`,
        section: 'apps',
        title: p,
        subtitle: 'Project',
        icon: Layers,
        href: `/projects/${p}`,
        keywords: ['project', 'compose', 'stack'],
      });

    // What can be done to the page you are on, offered first
    const open = (
      id: string,
      title: string,
      icon: Entry['icon'],
      href: string,
      keywords: string[] = [],
    ) =>
      list.push({
        id: `here:${id}`,
        section: 'here',
        title,
        icon,
        href,
        keywords,
      });
    const appMatch = /^\/apps\/([^/]+)/.exec(pathname);
    const projectMatch = /^\/projects\/([^/]+)/.exec(pathname);
    const groupMatch = /^\/collections\/([^/]+)/.exec(pathname);
    const current = appMatch
      ? apps.find((a) => a.name === appMatch[1])
      : undefined;
    if (current) {
      const n = current.name;
      const after =
        (what: string, done: string) =>
        async (work: () => Promise<{ ok: boolean; error?: string }>) => {
          const res = await work();
          if (!res.ok) toast.error(res.error ?? `Could not ${what} ${n}`);
          else {
            toast.success(done);
            router.refresh();
          }
        };
      if (current.state === 'stopped')
        list.push({
          id: 'here:start',
          section: 'here',
          title: `Start ${n}`,
          icon: Play,
          keywords: ['run', 'on'],
          run: () =>
            after(
              'start',
              `Starting ${n}`,
            )(() => updateAppAction(n, { instanceCount: 1 })),
        });
      else
        list.push(
          {
            id: 'here:restart',
            section: 'here',
            title: `Restart ${n}`,
            icon: RotateCw,
            keywords: ['reboot', 'redeploy'],
            run: () =>
              after('restart', `Restarting ${n}`)(() => restartAppAction(n)),
          },
          {
            id: 'here:stop',
            section: 'here',
            title: `Stop ${n}`,
            icon: Square,
            keywords: ['off', 'scale to zero'],
            run: () =>
              after(
                'stop',
                `Stopping ${n}`,
              )(() => updateAppAction(n, { instanceCount: 0 })),
          },
        );
      // Every page and setting of this app, first among the results once something is typed
      for (const page of appNav().filter((p) => p.href)) {
        list.push({
          id: `here:page${page.href}`,
          section: 'here',
          title: page.label,
          subtitle: 'This app',
          icon: Boxes,
          href: `/apps/${n}${page.href}`,
          keywords: ['page', n],
          searchOnly: true,
        });
        for (const s of page.sections)
          list.push({
            id: `here:page${page.href}#${s.id}`,
            section: 'here',
            title: `${page.label} · ${s.label}`,
            subtitle: 'This app',
            icon: Boxes,
            href: `/apps/${n}${page.href}#${s.id}`,
            keywords: ['setting', 'settings', ...(s.keywords ?? [])],
            searchOnly: true,
          });
      }
      open('deploy', 'Deploy an image…', Rocket, `/apps/${n}/deploy#deploy`, [
        'release',
        'update',
        'roll back',
        'version',
      ]);
      open('logs', 'View logs', ScrollText, `/apps/${n}/logs`, [
        'output',
        'console',
      ]);
      open('domain', 'Add a domain…', Globe, `/apps/${n}/networking#domains`, [
        'https',
        'ssl',
        'certificate',
        'address',
      ]);
      open(
        'env',
        'Add an environment variable…',
        Variable,
        `/apps/${n}/configuration#environment`,
        ['env', 'config', 'setting'],
      );
      open(
        'secret',
        'Add a secret…',
        KeyRound,
        `/apps/${n}/configuration#secrets`,
        ['password', 'token'],
      );
      open(
        'key',
        'Create a deploy key…',
        KeyRound,
        `/apps/${n}/deploy#deploy-keys`,
        ['ci', 'github actions', 'token', 'api key'],
      );
      if (!current.project)
        open('rename', `Rename ${n}…`, Pencil, `/apps/${n}?rename=1`, ['name']);
      const pinnedNow = pinned.includes(n);
      list.push({
        id: 'here:pin',
        section: 'here',
        title: pinnedNow
          ? `Unpin ${n} from the sidebar`
          : `Pin ${n} to the sidebar`,
        icon: Pin,
        keywords: ['favorite', 'bookmark'],
        run: () => togglePinned(n),
      });
      if (current.project)
        open(
          'project',
          `Open the project ${current.project}`,
          Layers,
          `/projects/${current.project}`,
        );
    }
    if (projectMatch) {
      const p = projectMatch[1];
      open(
        'add-service',
        `Add a service to ${p}…`,
        Plus,
        `/projects/${p}?add=service`,
        ['image', 'container'],
      );
      open(
        'add-template',
        `Add a template to ${p}…`,
        LayoutTemplate,
        `/projects/${p}?add=template`,
        ['database', 'redis', 'postgres'],
      );
    }
    if (groupMatch)
      open(
        'new-in-group',
        'New app in this collection',
        Plus,
        `/collections/${groupMatch[1]}?new=1&group=${groupMatch[1]}`,
        ['create'],
      );

    list.push(
      {
        id: 'action:new-app',
        section: 'actions',
        title: 'New app',
        subtitle: 'Create an app',
        icon: Plus,
        href: '/apps?new=1',
        hint: 'n',
        keywords: ['create', 'add', 'register'],
      },
      {
        id: 'action:new-compose',
        section: 'actions',
        title: 'New compose project',
        subtitle: 'Several services from a compose file',
        icon: Layers,
        href: '/apps?compose=1',
        keywords: ['stack', 'docker compose', 'create'],
      },
      {
        id: 'action:registries',
        section: 'actions',
        title: 'Add a template registry',
        subtitle: 'Your own templates',
        icon: LayoutTemplate,
        href: '/settings/template-registries#add',
        keywords: ['templates', 'source', 'git', 'catalog'],
      },
      {
        id: 'action:shortcuts',
        section: 'actions',
        title: 'Keyboard shortcuts',
        subtitle: 'What the keys do',
        icon: Keyboard,
        hint: '?',
        keywords: ['keys', 'hotkeys', 'help'],
        run: () => onShowShortcuts?.(),
      },
      {
        id: 'action:theme',
        section: 'actions',
        title:
          resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: resolved === 'dark' ? Sun : Moon,
        keywords: ['theme', 'appearance', 'dark', 'light'],
        run: () => setTheme(resolved === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'action:change-password',
        section: 'actions',
        title: 'Change password',
        subtitle: 'Update the server password',
        icon: ShieldCheck,
        href: '/settings/access#password',
        keywords: ['security'],
      },
      {
        id: 'action:sign-out',
        section: 'actions',
        title: 'Sign out',
        icon: LogOut,
        keywords: ['log out', 'logout'],
        run: () => void logoutAction(),
      },
    );
    return list;
  }, [
    apps,
    groups,
    onShowShortcuts,
    pathname,
    pinned,
    resolved,
    router,
    setTheme,
    togglePinned,
  ]);

  const choose = useCallback(
    (entry: Entry) => {
      onOpenChange(false);
      if (entry.id !== 'action:sign-out')
        writeRecents([
          entry.id,
          ...readRecents().filter((r) => r !== entry.id),
        ]);
      if (entry.run) startTransition(() => void entry.run?.());
      else if (entry.href) router.push(entry.href);
    },
    [onOpenChange, router],
  );

  const { mode, text } = parse(query);
  const visible = entries.filter(
    (e) =>
      (!mode || e.section === mode) &&
      (text ? true : !e.searchOnly) &&
      matches(e, text),
  );
  const rank = (e: Entry) =>
    text && e.title.toLowerCase().startsWith(text.toLowerCase()) ? 0 : 1;
  visible.sort((a, b) => rank(a) - rank(b));
  const recentEntries =
    !mode && !text
      ? recents
          .map((id) => entries.find((e) => e.id === id))
          .filter((e): e is Entry => !!e)
      : [];
  const grouped = (['here', 'pages', 'apps', 'actions'] as Section[]).map(
    (s) => ({
      section: s,
      items: visible.filter(
        (e) => e.section === s && !recentEntries.some((r) => r.id === e.id),
      ),
    }),
  );

  const hereLabel = (() => {
    const m = /^\/(apps|projects|collections)\/([^/]+)/.exec(pathname);
    if (!m) return 'Here';
    const name =
      m[1] === 'collections'
        ? (groups.find((g) => g.id === m[2])?.name ?? 'this group')
        : m[2];
    return `On ${name}`;
  })();

  const row = (e: Entry) => (
    <CommandItem key={e.id} value={e.id} onSelect={() => choose(e)}>
      <e.icon className="h-4 w-4 text-muted-foreground" />
      <span>{e.title}</span>
      {e.subtitle && (
        <span className="ml-auto text-xs text-muted-foreground">
          {e.subtitle}
        </span>
      )}
      {e.hint && (
        <kbd
          className={`${e.subtitle ? '' : 'ml-auto '}hidden rounded border bg-muted px-1.5 font-sans text-[11px] text-muted-foreground sm:inline`}
        >
          {e.hint}
        </kbd>
      )}
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a page or app, or run an action"
      showCloseButton={false}
      className="top-[20%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search apps and pages…  > actions   # apps   / pages"
      />
      {/* filtering is done above; cmdk only handles keyboard selection */}
      <CommandList>
        <CommandEmpty>
          <Search className="mx-auto mb-2 h-4 w-4 text-muted-foreground" />
          Nothing matches “{query}”.
        </CommandEmpty>
        {recentEntries.length > 0 && (
          <CommandGroup heading="Recent">{recentEntries.map(row)}</CommandGroup>
        )}
        {grouped.map(
          (g) =>
            g.items.length > 0 && (
              <CommandGroup
                key={g.section}
                heading={
                  g.section === 'here' ? hereLabel : SECTION_LABEL[g.section]
                }
              >
                {g.items.map(row)}
              </CommandGroup>
            ),
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
        <span>↑↓ to move</span>
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" /> to open · esc to close
        </span>
      </div>
    </CommandDialog>
  );
}
