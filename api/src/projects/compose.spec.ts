import {
  parseBytes,
  parseDuration,
  planCompose,
  splitCommand,
} from './compose';

const plan = (yaml: string, vars: Record<string, string> = {}) =>
  planCompose(yaml, 'shop', vars, '2026-01-01T00:00:00Z');
const messages = (xs: { message: string }[]) =>
  xs.map((x) => x.message).join('\n');

const FULL = `
services:
  web:
    image: ghcr.io/acme/web:1.2
    environment:
      DATABASE_URL: postgres://app:\${DB_PASS:-secret}@db:5432/app
      NODE_ENV: production
    ports: ["8080:3000"]
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      replicas: 2
      resources:
        limits: { cpus: "0.5", memory: 256M }
  db:
    image: postgres:16
    environment: ["POSTGRES_PASSWORD=secret"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 10s
      retries: 5
volumes:
  pgdata:
`;

describe('planCompose: a realistic project', () => {
  const p = plan(FULL);

  it('plans without errors', () => {
    expect(p.errors).toEqual([]);
  });
  it('starts dependencies first', () => {
    expect(p.apps.map((a) => a.name)).toEqual(['shop-db', 'shop-web']);
  });
  it('names apps after project and service and keeps the service name as alias', () => {
    expect(p.apps[0]).toMatchObject({
      name: 'shop-db',
      project: 'shop',
      serviceAlias: 'db',
    });
  });
  it('resolves variables with defaults', () => {
    expect(p.apps[1].env).toContainEqual({
      key: 'DATABASE_URL',
      value: 'postgres://app:secret@db:5432/app',
    });
  });
  it('maps ports, replicas, restart and limits', () => {
    const web = p.apps[1];
    expect(web.ports).toEqual([
      { containerPort: 3000, hostPort: 8080, protocol: 'tcp' },
    ]);
    expect(web.instanceCount).toBe(2);
    expect(web.restart).toBe('any');
    expect(web.resources).toEqual({
      cpus: 0.5,
      memoryBytes: 256 * 1024 * 1024,
    });
  });
  it('makes services with volumes persistent and keeps volume names', () => {
    const db = p.apps[0];
    expect(db.persistent).toBe(true);
    expect(db.volumes).toEqual([
      {
        containerPath: '/var/lib/postgresql/data',
        volumeName: 'pgdata',
        readOnly: false,
      },
    ]);
    expect(p.volumes).toEqual(['pgdata']);
  });
  it('maps the healthcheck and records dependencies by app name', () => {
    expect(p.apps[0].healthcheck).toEqual({
      test: ['CMD-SHELL', 'pg_isready'],
      intervalSeconds: 10,
      retries: 5,
    });
    expect(p.apps[1].dependsOn).toEqual(['shop-db']);
  });
  it('does not expose services publicly by default', () => {
    expect(p.apps.every((a) => a.exposed === false)).toBe(true);
  });
  it('warns that waiting for healthy means waiting for running', () => {
    expect(messages(p.warnings)).toMatch(/healthy/);
  });
});

describe('planCompose: refusals', () => {
  const svc = (body: string) =>
    plan(`services:\n  app:\n    image: nginx\n${body}`);

  it.each([
    ['privileged: true', /Privileged/],
    ['cap_add: [NET_ADMIN]', /capabilities/],
    ['devices: ["/dev/sda:/dev/sda"]', /devices/],
    ['network_mode: host', /network_mode/],
    ['pid: host', /PID/],
    ['env_file: .env', /env_file/],
    ['extends: { service: x }', /extends/],
    ['security_opt: ["seccomp:unconfined"]', /security_opt/],
  ])('refuses %s', (line, re) => {
    const p = svc(`    ${line}`);
    expect(messages(p.errors)).toMatch(re);
    expect(p.apps).toEqual([]);
  });

  it('refuses build without an image', () => {
    expect(messages(plan('services:\n  app:\n    build: .').errors)).toMatch(
      /Building images/,
    );
  });
  it('refuses host bind mounts, in short and long form', () => {
    expect(messages(svc('    volumes: ["/etc:/host-etc"]').errors)).toMatch(
      /directory on the server/,
    );
    expect(messages(svc('    volumes: ["./data:/data"]').errors)).toMatch(
      /directory on the server/,
    );
    expect(
      messages(
        svc('    volumes:\n      - { type: bind, source: /srv, target: /s }')
          .errors,
      ),
    ).toMatch(/directory on the server/);
  });
  it('refuses to publish a port the server or the platform uses', () => {
    for (const port of [
      '22:22',
      '80:8080',
      '443:443',
      '2377:2377',
      '4789:4789/udp',
    ])
      expect(messages(svc(`    ports: ["${port}"]`).errors)).toMatch(
        /used by the server and the platform/,
      );
  });

  it('refuses ports bound to a specific address or given as ranges', () => {
    expect(messages(svc('    ports: ["127.0.0.1:8080:80"]').errors)).toMatch(
      /binds to 127\.0\.0\.1/,
    );
    expect(messages(svc('    ports: ["8000-8010:8000-8010"]').errors)).toMatch(
      /ranges/,
    );
  });
  it('refuses undeclared, external and non-local volumes', () => {
    expect(messages(svc('    volumes: ["nope:/d"]').errors)).toMatch(
      /not declared/,
    );
    expect(
      messages(
        plan(
          'services:\n  a:\n    image: x\nvolumes:\n  v:\n    external: true',
        ).errors,
      ),
    ).toMatch(/external/);
    expect(
      messages(
        plan('services:\n  a:\n    image: x\nvolumes:\n  v:\n    driver: nfs')
          .errors,
      ),
    ).toMatch(/driver/);
  });
  it('refuses top-level secrets', () => {
    expect(
      messages(
        plan('services:\n  a:\n    image: x\nsecrets:\n  s: {file: ./s}')
          .errors,
      ),
    ).toMatch(/secrets/i);
  });
  it('refuses a missing image, unknown dependencies and cycles', () => {
    expect(messages(plan('services:\n  a:\n    command: x').errors)).toMatch(
      /needs an "image"/,
    );
    expect(messages(svc('    depends_on: [ghost]').errors)).toMatch(/ghost/);
    const cyc = plan(
      'services:\n  a:\n    image: x\n    depends_on: [b]\n  b:\n    image: x\n    depends_on: [a]',
    );
    expect(messages(cyc.errors)).toMatch(/circle/);
  });
  it('refuses service names that cannot become app names', () => {
    expect(
      messages(plan('services:\n  My_Service:\n    image: x').errors),
    ).toMatch(/lowercase|letters/);
  });
  it('refuses a required variable that is missing', () => {
    expect(
      messages(svc('    environment:\n      A: ${NEED:?set NEED}').errors),
    ).toMatch(/set NEED/);
  });
});

describe('planCompose: tolerated input', () => {
  it('ignores harmless keys with a warning and unknown keys with another', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    container_name: foo\n    mystery: 1',
    );
    expect(p.errors).toEqual([]);
    expect(messages(p.warnings)).toMatch(/container_name/);
    expect(messages(p.warnings)).toMatch(/Unknown key "mystery"/);
  });
  it('accepts privileged: false and an empty cap_add', () => {
    expect(
      plan(
        'services:\n  a:\n    image: x\n    privileged: false\n    cap_add: []',
      ).errors,
    ).toEqual([]);
  });
  it('clamps replicas for services with volumes', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    volumes: ["d:/d"]\n    deploy: { replicas: 3 }\nvolumes:\n  d:',
    );
    expect(p.apps[0].instanceCount).toBe(1);
    expect(messages(p.warnings)).toMatch(/single instance/);
  });
  it('drops anonymous volumes with a warning', () => {
    const p = plan('services:\n  a:\n    image: x\n    volumes: ["/cache"]');
    expect(p.apps[0].volumes).toEqual([]);
    expect(p.apps[0].persistent).toBe(false);
    expect(messages(p.warnings)).toMatch(/Anonymous volume/);
  });
  it('uses an unpublished container port for routing hints', () => {
    expect(
      plan('services:\n  a:\n    image: x\n    ports: ["3000"]').apps[0]
        .containerPort,
    ).toBe(3000);
  });
  it('splits string commands', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    command: sh -c "echo hi"\n    entrypoint: /run.sh',
    );
    expect(p.apps[0].command).toEqual(['sh', '-c', 'echo hi']);
    expect(p.apps[0].entrypoint).toEqual(['/run.sh']);
  });
  it('handles list-style and valueless environment', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    environment: ["A=1", "B"]',
    );
    expect(p.apps[0].env).toEqual([{ key: 'A', value: '1' }]);
    expect(messages(p.warnings)).toMatch(/Variable B has no value/);
  });
  it('supports long-form ports and volumes', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    ports:\n      - { target: 53, published: 5353, protocol: udp }\n    volumes:\n      - { type: volume, source: d, target: /d, read_only: true }\nvolumes:\n  d:',
    );
    expect(p.apps[0].ports).toEqual([
      { containerPort: 53, hostPort: 5353, protocol: 'udp' },
    ]);
    expect(p.apps[0].volumes[0].readOnly).toBe(true);
  });
  it('treats ":ro" short volumes as read only', () => {
    const p = plan(
      'services:\n  a:\n    image: x\n    volumes: ["d:/d:ro"]\nvolumes:\n  d:',
    );
    expect(p.apps[0].volumes[0].readOnly).toBe(true);
  });
});

describe('planCompose: x-provelox', () => {
  const web = (extra: string) =>
    plan(`services:\n  web:\n    image: x\n${extra}`);
  it('exposes a service and sets the port the proxy uses', () => {
    const a = web('    x-provelox:\n      expose: true\n      port: 3001')
      .apps[0];
    expect(a.exposed).toBe(true);
    expect(a.containerPort).toBe(3001);
  });
  it('keeps services private by default', () => {
    expect(web('    ports: ["8080:80"]').apps[0].exposed).toBe(false);
  });
  it('prefers x-provelox.port over a port found in "ports"', () => {
    expect(
      web(
        '    ports: ["8080:80"]\n    x-provelox: { expose: true, port: 3000 }',
      ).apps[0].containerPort,
    ).toBe(3000);
  });
  it('explains bad values and unknown keys', () => {
    expect(messages(web('    x-provelox: { expose: "yes" }').errors)).toMatch(
      /true or false/,
    );
    expect(messages(web('    x-provelox: { port: 99999 }').errors)).toMatch(
      /port number/,
    );
    expect(messages(web('    x-provelox: [1]').errors)).toMatch(
      /must be a map/,
    );
    expect(
      messages(web('    x-provelox: { expose: true, color: red }').warnings),
    ).toMatch(/x-provelox\.color/);
  });
});

describe('planCompose: bad input never throws', () => {
  it('reports invalid YAML', () => {
    expect(messages(plan('services: [unclosed').errors)).toMatch(
      /not valid YAML/,
    );
  });
  it('requires services', () => {
    expect(messages(plan('version: "3"').errors)).toMatch(/services/);
    expect(plan('').errors.length).toBeGreaterThan(0);
  });
  it('rejects an invalid project name and oversize files', () => {
    expect(
      messages(planCompose('services:\n  a:\n    image: x', 'Bad_Name').errors),
    ).toMatch(/Project/);
    expect(messages(planCompose('x'.repeat(300 * 1024), 'p').errors)).toMatch(
      /too large/,
    );
  });
  it('survives alias bombs', () => {
    const bomb =
      'a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\nservices:\n  s:\n    image: x';
    expect(() => plan(bomb)).not.toThrow();
    expect(messages(plan(bomb).errors)).toMatch(/cannot be read/);
  });
});

describe('helpers', () => {
  it('splitCommand', () => {
    expect(splitCommand(`a "b c" 'd e' f`)).toEqual(['a', 'b c', 'd e', 'f']);
    expect(splitCommand('')).toEqual([]);
  });
  it('parseDuration', () => {
    expect(parseDuration('1m30s')).toBe(90);
    expect(parseDuration('500ms')).toBe(0.5);
    expect(parseDuration('soon')).toBeNull();
  });
  it('parseBytes', () => {
    expect(parseBytes('512m')).toBe(536870912);
    expect(parseBytes('1g')).toBe(1073741824);
    expect(parseBytes('1.5GB')).toBe(1610612736);
    expect(parseBytes('lots')).toBeNull();
  });
});

describe('commands with variables', () => {
  it('keeps a value with spaces as one argument', () => {
    const r = plan(
      'services:\n  a:\n    image: redis:7\n    command: redis-server --requirepass ${PW} --appendonly yes\n',
      { PW: 'two words' },
    );
    expect(r.errors).toEqual([]);
    expect(r.apps[0].command).toEqual([
      'redis-server',
      '--requirepass',
      'two words',
      '--appendonly',
      'yes',
    ]);
  });

  it('keeps quotes, dollar signs and brackets inside a value as they are', () => {
    const r = plan('services:\n  a:\n    image: x\n    command: run ${PW}\n', {
      PW: `it's "a" $HOME [x]`,
    });
    expect(r.apps[0].command).toEqual(['run', `it's "a" $HOME [x]`]);
  });

  it('keeps a default that has spaces in one piece', () => {
    const r = plan(
      'services:\n  a:\n    image: x\n    command: run ${MSG:-hello there world}\n',
      {},
    );
    expect(r.apps[0].command).toEqual(['run', 'hello there world']);
  });

  it('still splits an ordinary command and honours quotes around literal text', () => {
    const r = plan(
      "services:\n  a:\n    image: x\n    command: sh -c 'echo hi there'\n",
      {},
    );
    expect(r.apps[0].command).toEqual(['sh', '-c', 'echo hi there']);
  });

  it('does the same for an entrypoint', () => {
    const r = plan(
      'services:\n  a:\n    image: x\n    entrypoint: /run.sh ${A}\n',
      { A: 'x y' },
    );
    expect(r.apps[0].entrypoint).toEqual(['/run.sh', 'x y']);
  });
});

describe('planCompose: image reference', () => {
  it('rejects an image with stray text after the tag', () => {
    const p = plan('services:\n  web:\n    image: ${IMG}\n', {
      IMG: 'ghcr.io/acme/web:1.2 Environment',
    });
    expect(messages(p.errors)).toMatch(/contains a space/);
  });
});

describe('planCompose: x-provelox.variables', () => {
  const file = (decl: string) =>
    `x-provelox:\n  variables:\n${decl}\nservices:\n  web:\n    image: x\n    environment:\n      K: \${KEY}\n`;
  it('refuses a value shorter than its minLength, and accepts a long enough one', () => {
    const f = file('    KEY: { secret: true, minLength: 32 }');
    expect(messages(plan(f, { KEY: 'short' }).errors)).toMatch(
      /KEY must be at least 32 characters \(it is 5\)/,
    );
    expect(plan(f, { KEY: 'a'.repeat(32) }).errors).toEqual([]);
  });
  it('does not complain about a value that is not given yet', () => {
    expect(plan(file('    KEY: { minLength: 32 }'), {}).errors).toEqual([]);
  });
  it('reports a bad declaration', () => {
    expect(messages(plan(file('    KEY: { minLength: 0 }')).errors)).toMatch(
      /minLength" must be a whole number/,
    );
    expect(messages(plan(file('    KEY: 3')).errors)).toMatch(/must be a map/);
    expect(messages(plan(file('    KEY: { colour: red }')).warnings)).toMatch(
      /x-provelox.variables.KEY.colour/,
    );
  });
});

describe('planCompose: variables declared without a space after the colon', () => {
  const file = (decl: string) =>
    `x-provelox:\n  variables:\n    PW: ${decl}\nservices:\n  db:\n    image: mysql:5.7\n    environment:\n      P: \${PW}\n`;

  it('reads {secret:true,minLength:16} as written: no "unknown key" warning, and the length is enforced', () => {
    const short = planCompose(
      file('{secret:true,minLength:16,label: Root}'),
      'p',
      { PW: 'short' },
    );
    expect(short.warnings).toEqual([]);
    expect(short.errors.map((e) => e.message)).toEqual([
      'PW must be at least 16 characters (it is 5).',
    ]);
    const ok = planCompose(file('{secret:true,minLength:16}'), 'p', {
      PW: 'x'.repeat(16),
    });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);
  });

  it('still warns about a key that really is unknown', () => {
    const r = planCompose(file('{secret:true,colour:red}'), 'p', { PW: 'abc' });
    expect(r.warnings.map((w) => w.message).join()).toContain('colour');
  });
});
