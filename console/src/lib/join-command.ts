export interface JoinTarget {
  /** host or host:port of the manager; the port defaults to 2377 */
  manager: string;
  /** The new server's own address, when Docker cannot choose it; empty to leave it out */
  advertise: string;
}

const HOST =
  /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:(\d{1,5}))?$/;
// an address, or the name of a network interface (eth0, ens3): what `--advertise-addr` accepts
const ADVERTISE =
  /^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-fA-F:]{2,39}|[A-Za-z][A-Za-z0-9._-]{0,14})$/;

/** The manager as host:port, or why it cannot be one. */
export function checkManager(
  value: string,
): { ok: true; address: string } | { ok: false; error: string } {
  const m = value.trim().match(HOST);
  const port = m?.[4] ? Number(m[4]) : 2377;
  if (!m || port < 1 || port > 65535)
    return {
      ok: false,
      error:
        'Enter the manager as an address, like 203.0.113.10 or 10.0.0.1:2377.',
    };
  return { ok: true, address: `${m[1]}:${port}` };
}

export function checkAdvertise(
  value: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = value.trim();
  if (!v) return { ok: true, value: '' };
  if (!ADVERTISE.test(v))
    return {
      ok: false,
      error: 'Enter the new server’s IP address, like 203.0.113.20.',
    };
  return { ok: true, value: v };
}

/** The commands to run on the new server, for the chosen manager address and the new server's own address. */
export function joinCommands(
  token: string,
  image: string,
  manager: string,
  advertise: string,
) {
  return {
    provelox: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${image} join --token ${token} --manager ${manager}${advertise ? ` --advertise-addr ${advertise}` : ''}`,
    swarm: `docker swarm join --token ${token}${advertise ? ` --advertise-addr ${advertise}` : ''} ${manager}`,
  };
}
