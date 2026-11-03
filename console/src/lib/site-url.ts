export interface ProxyPorts {
  http: number;
  https: number;
}

export const STANDARD_PORTS: ProxyPorts = { http: 80, https: 443 };

/** The address visitors use for a host. The port only shows when the proxy is not on the standard 80/443. */
export function siteUrl(
  host: { host: string; ssl: boolean },
  ports: ProxyPorts = STANDARD_PORTS,
): string {
  const port = host.ssl ? ports.https : ports.http;
  const standard = host.ssl ? 443 : 80;
  return `${host.ssl ? 'https' : 'http'}://${host.host}${port === standard ? '' : `:${port}`}`;
}
