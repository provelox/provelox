'use client';

import { LogOut, Menu, Search, Settings, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { logoutAction } from '@/actions/auth';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  UpdateBell,
  UpdateChip,
  useUpdateIndicator,
} from '@/components/update-notice';
import type { UpdateNotice } from '@/lib/updates';
import { formatVersion } from '@/lib/version';
import { NAV_GROUPS } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { CommandPalette, usePaletteOpen } from './command-palette';
import { ShortcutsDialog, useShortcuts } from './shortcuts';
import { SidebarApps, type ShellApp } from './sidebar-apps';

export function AppShell({
  apps,
  groups,
  version,
  update = null,
  children,
}: {
  apps: ShellApp[];
  groups: { id: string; name: string }[];
  /** The release this instance runs, as the API reports it */
  version: string | null;
  /** A newer release than the one running: told in the header and beside the version */
  update?: UpdateNotice | null;

  children: ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = usePaletteOpen();
  const [isMac, setIsMac] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  // `/` goes to the page's own search box, and to the command palette on a page without one
  useShortcuts({
    onSearchFallback: () => setPaletteOpen(true),
    onHelp: () => setHelpOpen(true),
  });

  useEffect(() => setIsMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  useEffect(() => setNavOpen(false), [pathname]);
  const onSettings = pathname.startsWith('/settings');
  const indicator = useUpdateIndicator(update);

  return (
    <div className="min-h-screen">
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <Link
            href="/apps"
            aria-label="Provelox home"
            className="flex items-center coarse:min-h-11"
          >
            <Logo />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:text-foreground coarse:h-11 coarse:min-w-11 coarse:justify-center sm:w-64"
          >
            <Search className="h-4 w-4" />
            {/* the name comes from what is written on it; on a phone, where only the icon shows, this is it */}
            <span className="sr-only sm:hidden">Search and commands</span>
            <span className="hidden flex-1 text-left sm:inline">Search…</span>
            <kbd className="hidden rounded border bg-muted px-1.5 font-sans text-[11px] sm:inline">
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>
          </button>
          {update && indicator.bell && (
            <UpdateBell
              notice={update}
              onHide={() => indicator.dismiss(update.latest)}
            />
          )}
          <ThemeToggle />
          <form action={logoutAction}>
            <SubmitButton variant="ghost" size="sm" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </SubmitButton>
          </form>
        </div>
      </header>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 flex w-60 flex-col overflow-y-auto border-r bg-card pb-4 pt-16 transition-transform lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <nav className="flex-1 px-3" aria-label="Main">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.id} className={gi > 0 ? 'mt-5' : ''}>
              <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  // a group's or a project's page is part of Apps
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(`${item.href}/`) ||
                    (item.id === 'apps' &&
                      (pathname.startsWith('/collections/') ||
                        pathname.startsWith('/projects')));
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors coarse:h-11',
                          active
                            ? 'bg-secondary font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        {active && (
                          <span
                            aria-hidden
                            className="absolute -left-3 bottom-2 top-2 w-[3px] rounded-r bg-primary"
                          />
                        )}
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <SidebarApps apps={apps} />

          <div className="mt-5">
            <Link
              href="/settings"
              aria-current={onSettings ? 'page' : undefined}
              className={cn(
                'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors coarse:h-11',
                onSettings
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              {onSettings && (
                <span
                  aria-hidden
                  className="absolute -left-3 bottom-2 top-2 w-[3px] rounded-r bg-primary"
                />
              )}
              <Settings className="h-4 w-4 shrink-0" />
              Settings
            </Link>
          </div>
        </nav>
        <div className="mt-6 flex items-center gap-2 px-5 text-xs text-muted-foreground">
          <p data-testid="version">Provelox {formatVersion(version)}</p>
          {update && indicator.chip && <UpdateChip notice={update} />}
        </div>
      </aside>
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-10 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="pt-14 lg:pl-60">
        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        apps={apps}
        groups={groups}
        onShowShortcuts={() => setHelpOpen(true)}
      />
      <ShortcutsDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        isMac={isMac}
      />
    </div>
  );
}
