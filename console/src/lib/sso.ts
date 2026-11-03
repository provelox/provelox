export type SsoKind = 'google' | 'github' | 'oidc';

/** An identity provider, as `GET /v1/sso` lists it. The client secret is never sent back. */
export interface SsoProvider {
  id: string;
  kind: SsoKind;
  label: string;
  clientId: string;
  issuer: string | null;
}

export interface SsoInfo {
  /** The API has an address of its own for providers to return to, and the proxy can reach it */
  available: boolean;
  /** The one address to register at every provider */
  redirectUri: string | null;
  providers: SsoProvider[];
}

export const KIND_LABEL: Record<SsoKind, string> = {
  google: 'Google',
  github: 'GitHub',
  oidc: 'OpenID Connect (Okta, Microsoft, Keycloak…)',
};

/** Where to register the app, per kind, so the redirect address ends up in the right place */
export const KIND_HELP: Record<SsoKind, { url: string; text: string }> = {
  google: {
    url: 'https://console.cloud.google.com/apis/credentials',
    text: 'Google Cloud console → Credentials → OAuth client ID (Web application)',
  },
  github: {
    url: 'https://github.com/settings/developers',
    text: 'GitHub → Settings → Developer settings → OAuth Apps',
  },
  oidc: {
    url: '',
    text: 'Your provider’s admin page: create a web application and note its issuer address',
  },
};

/** Addresses and domains typed one per line or separated by commas, `#` comments allowed. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.replace(/#.*/, ''))
        .flatMap((l) => l.split(/[\s,]+/))
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Splits what was typed into email addresses and bare domains (`@corp.com` or `corp.com`) */
export function splitWho(text: string): {
  emails: string[];
  domains: string[];
} {
  const items = parseList(text);
  return {
    emails: items.filter(
      (x) => /^[^@\s]+@[^@\s]+$/.test(x) && !x.startsWith('@'),
    ),
    domains: items
      .filter((x) => !/^[^@\s]+@[^@\s]+$/.test(x) || x.startsWith('@'))
      .map((x) => x.replace(/^@/, '')),
  };
}

export function ssoId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}
