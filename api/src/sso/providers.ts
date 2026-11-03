/** The kinds of identity provider an app can ask visitors to sign in with. Microsoft, Okta, Keycloak and the like are `oidc`. */
export type SsoKind = 'google' | 'github' | 'oidc';

export interface SsoEndpoints {
  authorize: string;
  token: string;
  /** Google and OpenID Connect: the signed-in person's profile. GitHub reads two different endpoints instead. */
  userinfo?: string;
  scope: string;
  pkce: boolean;
}

export const GOOGLE: SsoEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
  pkce: true,
};

export const GITHUB: SsoEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  scope: 'read:user user:email',
  pkce: false,
};

export const GITHUB_USER = 'https://api.github.com/user';
export const GITHUB_EMAILS = 'https://api.github.com/user/emails';

/** The well-known address an OpenID Connect issuer publishes its endpoints at */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** Who signed in, as the provider reports it. The email is one the provider says it has verified. */
export interface Identity {
  email: string;
  name: string;
}

/** The rules an app sets for who may in: exact addresses, or whole email domains. Case does not matter. */
export function isAllowed(
  rules: { emails: string[]; domains: string[] },
  email: string,
): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const domain = e.slice(at + 1);
  return (
    rules.emails.some((x) => x.toLowerCase() === e) ||
    rules.domains.some((d) => d.toLowerCase().replace(/^@/, '') === domain)
  );
}
