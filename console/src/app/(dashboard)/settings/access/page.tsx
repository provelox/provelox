import { HashRedirect } from '@/components/hash-redirect';
import { SettingsHeader } from '@/components/settings-header';
import { loadAccessTokens } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { AccessTokensPanel } from './access-tokens-panel';
import { PasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

export default async function AccessSettingsPage() {
  const tokens = await withSession(loadAccessTokens);
  return (
    <>
      {/* deploy keys used to be a section here */}
      <HashRedirect map={{ 'api-keys': '/settings/deploy-keys' }} />
      <SettingsHeader
        title="Password & tokens"
        description="The console password, and read-only or operate tokens for other systems such as a monitoring hub."
      />
      <div id="password" className="scroll-mt-24">
        <PasswordForm />
      </div>
      <div id="access-tokens" className="scroll-mt-24">
        <AccessTokensPanel tokens={tokens} />
      </div>
    </>
  );
}
