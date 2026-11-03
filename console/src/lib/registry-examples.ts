/** Sample registry files, for the "How to make a registry" help. Built as objects so the escaping is always right. */
export interface ExampleFile {
  name: string;
  content: string;
}

export interface RegistryExample {
  id: string;
  label: string;
  summary: string;
  /** What to notice, one line each */
  notes: string[];
  files: ExampleFile[];
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

const DOCS_COMPOSE = `services:
  docs:
    image: nginx:alpine
    restart: unless-stopped
    x-provelox:
      expose: true
      port: 80
`;

const APP_COMPOSE = `services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME}
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER}"]
  adminer:
    image: adminer:latest
    restart: unless-stopped
    depends_on: [db]
    x-provelox:
      expose: true
      port: 8080
volumes:
  data:
`;

export const REGISTRY_EXAMPLES: RegistryExample[] = [
  {
    id: 'basic',
    label: 'Basic',
    summary: 'One template with its Compose file inline.',
    notes: [
      '"compose" is the Compose file as text. The index can also be YAML.',
      '"x-provelox: expose" gives the service a web address; "publicWeb" tells the card so.',
      '"icon" is a logo name, or the https address of a public image.',
    ],
    files: [
      {
        name: 'provelox-templates.json',
        content: json({
          name: 'Acme templates',
          templates: [
            {
              id: 'acme-docs',
              name: 'Acme Docs',
              description: 'Our internal documentation site.',
              category: 'Web',
              icon: 'nginx',
              mainService: 'docs',
              publicWeb: true,
              compose: DOCS_COMPOSE,
            },
          ],
        }),
      },
    ],
  },
  {
    id: 'variables',
    label: 'With variables',
    summary:
      'Values the person fills in when they deploy, some of them generated.',
    notes: [
      'Write ${NAME} in the Compose file wherever a value differs per deploy, then list it under "variables".',
      '"kind": "secret" hides the field and generates a password; "default" is what a text field starts with.',
      '"minLength" is the fewest characters the app accepts: a generated secret is at least that long, and a shorter value is refused.',
      '${NAME:-fallback} in the Compose file gives a fallback when nothing is typed; ${NAME:?message} makes it required.',
      '"connect" is how another app reaches the main service: {host} and {port} are filled in, and {NAME} is the value chosen.',
      'Use "$$" in the Compose file for a literal dollar sign.',
    ],
    files: [
      {
        name: 'provelox-templates.json',
        content: json({
          name: 'Acme templates',
          templates: [
            {
              id: 'acme-postgres',
              name: 'Postgres with Adminer',
              description: 'A database with a web page to browse it.',
              category: 'Database',
              icon: 'postgresql',
              mainService: 'db',
              port: 5432,
              connect:
                'postgresql://{DB_USER}:{DB_PASSWORD}@{host}:{port}/{DB_NAME}',
              publicWeb: true,
              variables: [
                {
                  key: 'DB_USER',
                  label: 'Username',
                  description: 'The database owner.',
                  default: 'app',
                },
                { key: 'DB_NAME', label: 'Database name', default: 'app' },
                {
                  key: 'DB_PASSWORD',
                  label: 'Password',
                  description: 'Generated for you. Replace it if you like.',
                  kind: 'secret',
                  minLength: 16,
                },
              ],
              compose: APP_COMPOSE,
            },
          ],
        }),
      },
    ],
  },
  {
    id: 'files',
    label: 'Compose in its own file',
    summary: 'Keep each Compose file next to the index instead of inside it.',
    notes: [
      '"composeFile" is a path relative to the index, or a full address. It is read when the registry is read.',
      'Handy in a git repository: the Compose file stays a normal file you can test with docker compose.',
      '"icon" can be the https address of a public image (it is loaded by the browser).',
    ],
    files: [
      {
        name: 'provelox-templates.json',
        content: json({
          name: 'Acme templates',
          templates: [
            {
              id: 'acme-docs',
              name: 'Acme Docs',
              description: 'Our internal documentation site.',
              category: 'Web',
              icon: 'https://example.com/acme-logo.svg',
              mainService: 'docs',
              publicWeb: true,
              composeFile: 'docs/compose.yml',
            },
          ],
        }),
      },
      { name: 'docs/compose.yml', content: DOCS_COMPOSE },
    ],
  },
];
