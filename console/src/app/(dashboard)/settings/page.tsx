import Link from 'next/link';
import { KpiIcon } from '@/components/ui/kpi';
import { todayText } from '@/lib/activity';
import {
  loadAccessTokens,
  loadActivity,
  loadApiKeys,
  loadCluster,
  loadRegistries,
  loadSystemInfo,
  loadTemplateSources,
} from '@/lib/backend';
import { SETTINGS_GROUPS } from '@/lib/nav';
import { withSession, withSessionOr } from '@/lib/with-session';

export const dynamic = 'force-dynamic';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Where everything stands, and a way into each page. */
export default async function SettingsOverview() {
  const [info, registries, sources, tokens, keys, cluster, activity] =
    await Promise.all([
      withSession(loadSystemInfo),
      withSessionOr(loadRegistries, []),
      withSessionOr(loadTemplateSources, []),
      withSessionOr(loadAccessTokens, []),
      withSessionOr(loadApiKeys, []),
      withSessionOr(loadCluster, null),
      // an API older than this console has no log: the card then says nothing
      withSessionOr((t) => loadActivity(t, {}, { limit: 200 }), null),
    ]);

  // The platform may be an older release than this console, and any of these may then answer differently or not at
  // all: what cannot be read is left off the card rather than failing the page
  const count = (v: unknown) => (Array.isArray(v) ? v.length : undefined);
  const nodes = count(cluster?.nodes);

  /** What a page's card says about its current state; `warn` when it wants attention */
  const status: Record<string, { text: string; warn?: boolean } | undefined> = {
    domain: info.rootDomain
      ? { text: info.rootDomain }
      : { text: 'No domain set', warn: true },
    access:
      count(tokens) !== undefined
        ? { text: plural(count(tokens) as number, 'access token') }
        : undefined,
    'deploy-keys':
      count(keys) !== undefined
        ? { text: plural(count(keys) as number, 'key') }
        : undefined,
    activity: Array.isArray(activity?.events)
      ? {
          text: todayText(
            activity.events.filter(
              (e) => Date.now() - new Date(e.at).getTime() < 86_400_000,
            ).length,
            200,
          ),
        }
      : undefined,
    registries:
      count(registries) !== undefined
        ? { text: `${count(registries)} saved` }
        : undefined,
    'template-registries':
      count(sources) !== undefined
        ? { text: `${count(sources)} added` }
        : undefined,
    servers:
      nodes !== undefined ? { text: plural(nodes, 'server') } : undefined,
    'platform-services': !info.proxy?.enabled
      ? { text: 'Proxy managed elsewhere' }
      : info.proxy.running
        ? { text: 'Proxy running' }
        : { text: 'Proxy not running', warn: true },
    connection:
      info.docker === 'ok'
        ? { text: 'Docker connected' }
        : { text: 'Docker unreachable', warn: true },
  };

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Everything about the platform itself. What each app needs (its
        variables, domains and storage) is on the app&apos;s own page.
      </p>
      {SETTINGS_GROUPS.map((g) => (
        <section key={g.id} aria-labelledby={`settings-${g.id}`}>
          <h2
            id={`settings-${g.id}`}
            className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            {g.label}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.pages.map((p) => {
              const st = status[p.id];
              return (
                <Link
                  key={p.id}
                  href={p.href}
                  className="group flex gap-3 rounded-xl border bg-card p-4 shadow-xs transition-all hover:-translate-y-px hover:border-primary/50 hover:shadow-md"
                >
                  <KpiIcon icon={p.icon} className="h-9 w-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{p.label}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {p.description}
                    </span>
                    {st && (
                      <span
                        className={
                          st.warn
                            ? 'mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400'
                            : 'mt-2 flex items-center gap-1.5 text-xs text-muted-foreground'
                        }
                      >
                        <span
                          className={
                            st.warn
                              ? 'h-1.5 w-1.5 rounded-full bg-amber-500'
                              : 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                          }
                        />
                        {st.text}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
