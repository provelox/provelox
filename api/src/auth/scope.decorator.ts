import { SetMetadata } from '@nestjs/common';

/**
 * What an access token may do. `read` looks at status and usage; `operate` also restarts, starts, stops and deploys
 * another version of the image an app already runs (never a different image: it would run with the app's secrets and
 * data); `update` is the fleet-management level: it also upgrades the platform to a newer release, sets the pages and defaults
 * a hub keeps the same across a fleet (error pages, the placeholder page, the default address, the ACME email,
 * notification webhooks, registry sign-ins, template registries) and applies blueprints, which may run any image as an app of their own.
 * None can change the domain, an existing app's secrets or the admin password: those need a signed-in admin.
 */
export type TokenScope = 'read' | 'operate' | 'update';

const RANK: Record<TokenScope, number> = { read: 0, operate: 1, update: 2 };

/** Each scope can do everything the ones before it can. */
export const scopeAllows = (held: TokenScope, needed: TokenScope) =>
  RANK[held] >= RANK[needed];

export const TOKEN_SCOPE = 'tokenScope';

/**
 * Opens a route to access tokens of at least this scope. Routes without it are for the signed-in admin only, so a
 * new route is closed to tokens until someone decides otherwise.
 */
export const Scope = (scope: TokenScope) => SetMetadata(TOKEN_SCOPE, scope);
