import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SettingsHeader } from '@/components/settings-header';
import { getApps } from '@/lib/app-data';
import { loadSystemInfo } from '@/lib/backend';
import { env } from '@/lib/env';
import { withSession } from '@/lib/with-session';

export const dynamic = 'force-dynamic';

export default async function ConnectionPage() {
  const [{ appDefinitions }, info] = await Promise.all([
    getApps(),
    withSession(loadSystemInfo),
  ]);
  const rows = [
    ['Provelox API', env().PROVELOX_API_URL],
    ['Docker', info.docker === 'ok' ? 'connected' : 'unreachable'],
    [
      'Proxy',
      !info.proxy.enabled
        ? 'not managed here'
        : info.proxy.running
          ? 'running'
          : 'not running',
    ],
    ['Root domain', info.rootDomain || 'not set'],
    ...(info.appsDomainCustom ? [['Apps domain', info.appsDomain]] : []),
    ["Let's Encrypt email", info.acmeEmail || 'not set'],
    ['Apps', String(appDefinitions.length)],
    ['Session length', `${env().SESSION_HOURS} hours`],
  ];
  return (
    <>
      <SettingsHeader
        title="Connection"
        description="How this console reaches the platform. Read only: the API address and session length are set through the console’s environment."
      />
      <Card>
        <CardHeader className="sr-only">
          <CardTitle>Connection</CardTitle>
          <CardDescription>Read only</CardDescription>
        </CardHeader>
        <CardContent className="divide-y pt-5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-mono text-xs">{v}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
