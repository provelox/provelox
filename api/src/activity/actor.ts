import type { Request } from 'express';

/** Who made a request, as the guard (or a public route that checks its own key) found out. Never holds a secret. */
export interface Actor {
  kind: 'admin' | 'token' | 'ci';
  /** The access token's or deploy key's name; "admin" for the signed-in admin */
  name: string;
  /** The access token's level */
  scope?: string;
  /** The one app a deploy key belongs to */
  app?: string;
}

type WithActor = Request & { actor?: Actor };

export const setActor = (req: Request, actor: Actor) => {
  (req as WithActor).actor = actor;
};

export const actorOf = (req: Request): Actor | undefined =>
  (req as WithActor).actor;
