import { HashRedirect } from '@/components/hash-redirect';

/** General settings are one page each now: an old link lands on the right one. */
export default function Moved() {
  return (
    <HashRedirect
      fallback="/settings/appearance"
      map={{
        appearance: '/settings/appearance',
        domain: '/settings/domain',
        notifications: '/settings/notifications',
        'platform-pages': '/settings/platform-pages',
      }}
    />
  );
}
