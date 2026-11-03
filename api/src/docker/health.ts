export type Health = 'healthy' | 'unhealthy' | 'starting' | 'none';

/**
 * What one container's status line says about its health check. Docker writes it in parentheses after the uptime:
 * "Up 3 minutes (healthy)", "Up 2 seconds (health: starting)", "Up 1 hour (unhealthy)". No parentheses: no check.
 */
export function healthOfStatusLine(line: string): Health {
  if (/\(unhealthy\)/i.test(line)) return 'unhealthy';
  if (/\(health: starting\)/i.test(line)) return 'starting';
  if (/\(healthy\)/i.test(line)) return 'healthy';
  return 'none';
}

/**
 * One reading for a service from its running instances: any unhealthy instance makes it unhealthy, then any still
 * starting. Healthy only when every instance that has a check is healthy. No check anywhere: none.
 */
export function serviceHealth(lines: string[]): Health {
  const each = lines.map(healthOfStatusLine);
  if (each.includes('unhealthy')) return 'unhealthy';
  if (each.includes('starting')) return 'starting';
  if (each.includes('healthy')) return 'healthy';
  return 'none';
}
