import { getApp } from '@/lib/app-data';
import { api, loadSystemInfo } from '@/lib/backend';
import { appNav } from '@/lib/nav';
import type { CdnProvider } from '@/lib/cdn';
import { withSession, withSessionOr } from '@/lib/with-session';
import { CollapsibleSection } from '../collapsible-section';
import { Section } from '@/components/section-nav';
import { SectionedPage } from '@/components/sectioned-page';
import { AliasesEditor } from './aliases-editor';
import { CdnCard } from './cdn-card';
import { SsoCard } from './sso-card';
import type { SsoInfo } from '@/lib/sso';
import { DomainsSection } from './domains-section';
import { ErrorPagesEditor } from './error-pages-editor';
import { InternalAddressCard } from './internal-address-card';
import { PasswordProtectionCard } from './password-protection-card';
import { PortsEditor } from './ports-editor';
import { WebAccessCard } from './web-access-card';

export const dynamic = 'force-dynamic';

export default async function NetworkingPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // Independent of each other: asked together, not one after the other. The two extras are missing on an API that
  // predates them, and then their cards are left out rather than failing the page.
  const [{ app, rootDomain, ports }, system, cdn, sso] = await Promise.all([
    getApp(name),
    withSession(loadSystemInfo),
    withSessionOr(
      (token) =>
        api<{ providers: CdnProvider[] }>('cdn', { token }).then(
          (r) => r.providers,
        ),
      null,
    ),
    withSessionOr((token) => api<SsoInfo>('sso', { token }), null),
  ]);
  const pages = app.customErrorPages ?? {};
  const customPages = Object.values(pages).filter(Boolean).length;
  // The sections are laid out in the order the app's rail lists them (lib/nav.ts): keep the two the same
  return (
    <SectionedPage
      aside={false}
      sections={appNav().find((p) => p.href === '/networking')?.sections ?? []}
    >
      <Section id="web">
        <WebAccessCard app={app} />
      </Section>
      <Section id="domains">
        <DomainsSection
          app={app}
          defaultDomain={`${app.appName}.${rootDomain}`}
          ports={ports}
          httpsReady={!!system.acmeEmail}
        />
      </Section>
      {sso && (
        <Section id="sso">
          <SsoCard
            key={JSON.stringify(app.sso ?? null)}
            appName={app.appName}
            initial={app.sso}
            info={sso}
          />
        </Section>
      )}
      <Section id="password">
        <PasswordProtectionCard
          key={JSON.stringify(app.basicAuth ?? null)}
          appName={app.appName}
          initial={app.basicAuth}
        />
      </Section>
      {cdn && (
        <Section id="cdn">
          <CdnCard
            // Only the saved setting resets the card: a refresh or a new CDN must not undo what is being picked
            key={JSON.stringify(app.cdn ?? null)}
            appName={app.appName}
            initial={app.cdn}
            providers={cdn}
          />
        </Section>
      )}
      <Section id="ports">
        <PortsEditor
          appName={app.appName}
          initial={app.ports}
          pendingPorts={app.pendingPorts ?? []}
        />
      </Section>
      <Section id="internal">
        <div className="flex flex-col gap-6">
          <InternalAddressCard app={app} />
          <AliasesEditor
            key={JSON.stringify(app.aliases ?? [])}
            appName={app.appName}
            initial={app.aliases ?? []}
          />
        </div>
      </Section>
      <Section id="error-pages">
        <CollapsibleSection
          title="Custom error pages"
          summary={
            customPages
              ? `${customPages} of 3 set`
              : 'None set: Provelox’s default pages are shown.'
          }
          defaultOpen={customPages > 0}
        >
          <ErrorPagesEditor appName={app.appName} initial={pages} />
        </CollapsibleSection>
      </Section>
    </SectionedPage>
  );
}
