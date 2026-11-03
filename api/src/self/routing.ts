const rule = (host: string) => `Host(\`${host}\`)`;

/**
 * Traefik labels that serve one of the platform's own services at a hostname. Underscores in the ids keep them clear
 * of any app (app names cannot contain them). With SSL on, plain HTTP is redirected: these services hand out tokens
 * and sessions.
 */
export function hostRoutingLabels(
  id: string,
  host: { host: string; ssl: boolean },
  port: number,
  certResolver: string,
): Record<string, string> {
  const labels: Record<string, string> = {
    [`traefik.http.services.${id}.loadbalancer.server.port`]: String(port),
  };
  const web = `traefik.http.routers.${id}-web`;
  labels[`${web}.rule`] = rule(host.host);
  labels[`${web}.entrypoints`] = 'web';
  labels[`${web}.service`] = id;
  if (host.ssl) {
    labels[`traefik.http.middlewares.${id}-https.redirectscheme.scheme`] =
      'https';
    labels[`traefik.http.middlewares.${id}-https.redirectscheme.permanent`] =
      'true';
    labels[`${web}.middlewares`] = `${id}-https`;
    const sec = `traefik.http.routers.${id}-websecure`;
    labels[`${sec}.rule`] = rule(host.host);
    labels[`${sec}.entrypoints`] = 'websecure';
    labels[`${sec}.service`] = id;
    labels[`${sec}.tls`] = 'true';
    labels[`${sec}.tls.certresolver`] = certResolver;
  }
  return labels;
}
