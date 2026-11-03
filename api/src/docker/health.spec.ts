import { healthOfStatusLine, serviceHealth } from './health';

describe('health from Docker status lines', () => {
  it('reads each way Docker writes it', () => {
    expect(healthOfStatusLine('Up 3 minutes (healthy)')).toBe('healthy');
    expect(healthOfStatusLine('Up 1 hour (unhealthy)')).toBe('unhealthy');
    expect(healthOfStatusLine('Up 2 seconds (health: starting)')).toBe(
      'starting',
    );
    expect(healthOfStatusLine('Up 5 minutes')).toBe('none');
    expect(healthOfStatusLine('')).toBe('none');
  });

  it('summarises a service: the worst instance decides', () => {
    expect(serviceHealth([])).toBe('none');
    expect(serviceHealth(['Up 1h (healthy)', 'Up 1h (healthy)'])).toBe(
      'healthy',
    );
    expect(serviceHealth(['Up 1h (healthy)', 'Up 1m (unhealthy)'])).toBe(
      'unhealthy',
    );
    expect(serviceHealth(['Up 1h (healthy)', 'Up 1s (health: starting)'])).toBe(
      'starting',
    );
    expect(serviceHealth(['Up 1h', 'Up 1h'])).toBe('none');
  });
});
