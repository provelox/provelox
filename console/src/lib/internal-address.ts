export interface InternalAddresses {
  /** The port the app listens on inside its container: the same for every name */
  port: number;
  /** Names any app on the instance reaches it by (its own name first, then its aliases) */
  shared: string[];
  /** The shorter name other services of the same Compose project use, when that differs */
  project?: { name: string; host: string };
}

/**
 * How other containers on the instance reach an app, with or without a domain: by name on the shared network, on the
 * port the app listens on. Nothing is published to the internet this way.
 */
export function internalAddresses(app: {
  appName: string;
  aliases?: string[];
  project?: string;
  serviceAlias?: string;
  containerHttpPort?: number;
}): InternalAddresses {
  const shared = [app.appName, ...(app.aliases ?? [])];
  return {
    port: app.containerHttpPort ?? 80,
    shared,
    project:
      app.project && app.serviceAlias && app.serviceAlias !== app.appName
        ? { name: app.project, host: app.serviceAlias }
        : undefined,
  };
}
