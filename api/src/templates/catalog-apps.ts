/**
 * The popular open-source apps people deploy most: content management, automation, analytics, team tools and AI front
 * ends. Each is the upstream project's own recommended image and settings, cut down to the few values a person has to
 * choose. Apps that need the Docker socket, a folder on the host, or a build step are not here, because a project
 * cannot give them that.
 *
 * Apps with a first-run page (a setup wizard or "create the admin account") say so in their description: whoever opens
 * it first sets it up, so open it right after deploying.
 */
import type { Template, TemplateVariable } from './catalog';

const secret = (
  key: string,
  label: string,
  description?: string,
): TemplateVariable => ({ key, label, description, kind: 'secret' });

const text = (
  key: string,
  label: string,
  fallback?: string,
  description?: string,
): TemplateVariable => ({
  key,
  label,
  description,
  default: fallback,
  kind: 'text',
});

const dbName = (fallback: string) => text('DB_NAME', 'Database name', fallback);
const dbUser = (fallback: string) => text('DB_USER', 'Database user', fallback);
const dbPassword = secret('DB_PASSWORD', 'Database password');

/** The PostgreSQL service most apps below share: a database and user named `name`, password from DB_PASSWORD */
const postgres = (name: string) => `  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${name}
      POSTGRES_USER: ${name}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
`;

/** The MariaDB service the PHP apps share */
const mariadb = (name: string) => `  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: ${name}
      MARIADB_USER: ${name}
      MARIADB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/mysql
`;

const dbRootPassword = secret('DB_ROOT_PASSWORD', 'Database root password');
const adminEmail = text('ADMIN_EMAIL', 'Admin email', 'admin@example.com');
const adminUser = text('ADMIN_USER', 'Admin username', 'admin');
const adminPassword = secret('ADMIN_PASSWORD', 'Admin password');
const publicUrl = (example: string) =>
  text(
    'PUBLIC_URL',
    'Public address',
    undefined,
    `The full address it will be opened at, for example ${example}`,
  );

const FIRST_VISIT =
  ' Open it right after deploying: the first visitor sets it up.';

export const APP_TEMPLATES: Template[] = [
  // ---- Content management
  {
    id: 'ghost',
    icon: 'ghost',
    name: 'Ghost',
    description:
      'A publishing platform for blogs and newsletters, with its own MySQL database.',
    category: 'CMS',
    mainService: 'ghost',
    port: 2368,
    publicWeb: true,
    variables: [
      text(
        'SITE_URL',
        'Public address',
        undefined,
        'The address the site will be opened at, for example https://blog.example.com',
      ),
      secret('DB_PASSWORD', 'Database password'),
    ],
    compose: `services:
  ghost:
    image: ghost:6
    restart: unless-stopped
    depends_on: [db]
    environment:
      url: \${SITE_URL}
      database__client: mysql
      database__connection__host: db
      database__connection__user: root
      database__connection__password: \${DB_PASSWORD}
      database__connection__database: ghost
    volumes:
      - content:/var/lib/ghost/content
    x-provelox:
      expose: true
      port: 2368
  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_PASSWORD}
      MYSQL_DATABASE: ghost
    volumes:
      - dbdata:/var/lib/mysql
volumes:
  content:
  dbdata:
`,
  },
  {
    id: 'directus',
    icon: 'directus',
    name: 'Directus',
    description:
      'A headless CMS and data platform: a ready admin app and API on top of a PostgreSQL database.',
    category: 'CMS',
    mainService: 'directus',
    port: 8055,
    publicWeb: true,
    variables: [
      text('ADMIN_EMAIL', 'Admin email', 'admin@example.com'),
      secret('ADMIN_PASSWORD', 'Admin password'),
      secret('KEY', 'Instance key'),
      secret('SECRET', 'Signing secret'),
      dbPassword,
    ],
    compose: `services:
  directus:
    image: directus/directus:11
    restart: unless-stopped
    depends_on: [db]
    environment:
      KEY: \${KEY}
      SECRET: \${SECRET}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      DB_CLIENT: pg
      DB_HOST: db
      DB_PORT: "5432"
      DB_DATABASE: directus
      DB_USER: directus
      DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - uploads:/directus/uploads
      - extensions:/directus/extensions
    x-provelox:
      expose: true
      port: 8055
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: directus
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: directus
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  uploads:
  extensions:
  dbdata:
`,
  },
  {
    id: 'drupal',
    icon: 'drupal',
    name: 'Drupal',
    description: `Drupal 11 with a PostgreSQL database. In the installer choose PostgreSQL and use the host "db".${FIRST_VISIT}`,
    category: 'CMS',
    mainService: 'drupal',
    port: 80,
    publicWeb: true,
    variables: [dbName('drupal'), dbUser('drupal'), dbPassword],
    compose: `services:
  drupal:
    image: drupal:11
    restart: unless-stopped
    depends_on: [db]
    volumes:
      - modules:/var/www/html/modules
      - profiles:/var/www/html/profiles
      - themes:/var/www/html/themes
      - sites:/var/www/html/sites
    x-provelox:
      expose: true
      port: 80
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${DB_NAME}
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  modules:
  profiles:
  themes:
  sites:
  dbdata:
`,
  },
  {
    id: 'joomla',
    icon: 'joomla',
    name: 'Joomla',
    description: `Joomla 5 with a MariaDB database already connected.${FIRST_VISIT}`,
    category: 'CMS',
    mainService: 'joomla',
    port: 80,
    publicWeb: true,
    variables: [
      dbName('joomla'),
      dbUser('joomla'),
      dbPassword,
      secret('DB_ROOT_PASSWORD', 'Database root password'),
    ],
    compose: `services:
  joomla:
    image: joomla:5
    restart: unless-stopped
    depends_on: [db]
    environment:
      JOOMLA_DB_HOST: db
      JOOMLA_DB_NAME: \${DB_NAME}
      JOOMLA_DB_USER: \${DB_USER}
      JOOMLA_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - site:/var/www/html
    x-provelox:
      expose: true
      port: 80
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${DB_NAME}
      MARIADB_USER: \${DB_USER}
      MARIADB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/mysql
volumes:
  site:
  dbdata:
`,
  },

  // ---- Automation and internal tools
  {
    id: 'n8n',
    icon: 'n8n',
    name: 'n8n',
    description: `Workflow automation: connect apps and APIs with a visual editor.${FIRST_VISIT}`,
    category: 'Automation',
    mainService: 'n8n',
    port: 5678,
    publicWeb: true,
    variables: [
      publicUrl('https://n8n.example.com'),
      secret(
        'N8N_ENCRYPTION_KEY',
        'Encryption key',
        'Protects saved credentials. Keep it: without it they cannot be read back.',
      ),
    ],
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      N8N_PROTOCOL: https
      N8N_EDITOR_BASE_URL: \${PUBLIC_URL}
      WEBHOOK_URL: \${PUBLIC_URL}/
      N8N_PROXY_HOPS: "1"
    volumes:
      - data:/home/node/.n8n
    x-provelox:
      expose: true
      port: 5678
volumes:
  data:
`,
  },
  {
    id: 'nocodb',
    icon: '/brands/nocodb.png',
    name: 'NocoDB',
    description: `A spreadsheet-style front end for databases: an open alternative to Airtable.${FIRST_VISIT}`,
    category: 'Automation',
    mainService: 'nocodb',
    port: 8080,
    publicWeb: true,
    variables: [secret('NC_AUTH_JWT_SECRET', 'Signing secret')],
    compose: `services:
  nocodb:
    image: nocodb/nocodb:latest
    restart: unless-stopped
    environment:
      NC_AUTH_JWT_SECRET: \${NC_AUTH_JWT_SECRET}
    volumes:
      - data:/usr/app/data
    x-provelox:
      expose: true
      port: 8080
volumes:
  data:
`,
  },
  {
    id: 'appsmith',
    icon: 'appsmith',
    name: 'Appsmith',
    description: `Build internal tools and dashboards on top of your databases and APIs.${FIRST_VISIT}`,
    category: 'Automation',
    mainService: 'appsmith',
    port: 80,
    publicWeb: true,
    variables: [],
    compose: `services:
  appsmith:
    image: appsmith/appsmith-ce:latest
    restart: unless-stopped
    volumes:
      - stacks:/appsmith-stacks
    x-provelox:
      expose: true
      port: 80
volumes:
  stacks:
`,
  },

  // ---- Productivity and team tools
  {
    id: 'nextcloud',
    icon: 'nextcloud',
    name: 'Nextcloud',
    description:
      'File sync and sharing, calendar and contacts, with a PostgreSQL database and an admin account created for you.',
    category: 'Productivity',
    mainService: 'nextcloud',
    port: 80,
    publicWeb: true,
    variables: [
      text(
        'TRUSTED_DOMAIN',
        'Domain',
        undefined,
        'The domain it will be opened on, without https://, for example cloud.example.com',
      ),
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
      dbPassword,
    ],
    compose: `services:
  nextcloud:
    image: nextcloud:31
    restart: unless-stopped
    depends_on: [db]
    environment:
      POSTGRES_HOST: db
      POSTGRES_DB: nextcloud
      POSTGRES_USER: nextcloud
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      NEXTCLOUD_ADMIN_USER: \${ADMIN_USER}
      NEXTCLOUD_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: \${TRUSTED_DOMAIN}
      OVERWRITEPROTOCOL: https
    volumes:
      - html:/var/www/html
    x-provelox:
      expose: true
      port: 80
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: nextcloud
      POSTGRES_USER: nextcloud
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  html:
  dbdata:
`,
  },
  {
    id: 'mattermost',
    icon: 'mattermost',
    name: 'Mattermost',
    description: `Team chat with channels, threads and file sharing, on PostgreSQL.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'mattermost',
    port: 8065,
    publicWeb: true,
    variables: [dbPassword],
    compose: `services:
  mattermost:
    image: mattermost/mattermost-team-edition:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      MM_SQLSETTINGS_DRIVERNAME: postgres
      MM_SQLSETTINGS_DATASOURCE: "postgres://mattermost:\${DB_PASSWORD}@db:5432/mattermost?sslmode=disable&connect_timeout=10"
    volumes:
      - config:/mattermost/config
      - data:/mattermost/data
      - logs:/mattermost/logs
      - plugins:/mattermost/plugins
    x-provelox:
      expose: true
      port: 8065
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: mattermost
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: mattermost
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  config:
  data:
  logs:
  plugins:
  dbdata:
`,
  },
  {
    id: 'paperless-ngx',
    icon: 'paperlessngx',
    name: 'Paperless-ngx',
    description:
      'Scan, index and search your documents. Includes PostgreSQL and Redis, and an admin account created for you.',
    category: 'Productivity',
    mainService: 'paperless',
    port: 8000,
    publicWeb: true,
    variables: [
      text(
        'PAPERLESS_URL',
        'Public address',
        undefined,
        'The address it will be opened at, for example https://docs.example.com',
      ),
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
      secret('SECRET_KEY', 'Secret key'),
      dbPassword,
    ],
    compose: `services:
  paperless:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    restart: unless-stopped
    depends_on: [db, broker]
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_DBHOST: db
      PAPERLESS_DBNAME: paperless
      PAPERLESS_DBUSER: paperless
      PAPERLESS_DBPASS: \${DB_PASSWORD}
      PAPERLESS_SECRET_KEY: \${SECRET_KEY}
      PAPERLESS_URL: \${PAPERLESS_URL}
      PAPERLESS_ADMIN_USER: \${ADMIN_USER}
      PAPERLESS_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/usr/src/paperless/data
      - media:/usr/src/paperless/media
    x-provelox:
      expose: true
      port: 8000
  broker:
    image: redis:7
    restart: unless-stopped
    volumes:
      - redisdata:/data
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: paperless
      POSTGRES_USER: paperless
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  data:
  media:
  redisdata:
  dbdata:
`,
  },
  {
    id: 'wikijs',
    icon: 'wikidotjs',
    name: 'Wiki.js',
    description: `A modern wiki for documentation and team knowledge, on PostgreSQL.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'wiki',
    port: 3000,
    publicWeb: true,
    variables: [dbPassword],
    compose: `services:
  wiki:
    image: ghcr.io/requarks/wiki:2
    restart: unless-stopped
    depends_on: [db]
    environment:
      DB_TYPE: postgres
      DB_HOST: db
      DB_PORT: "5432"
      DB_USER: wiki
      DB_PASS: \${DB_PASSWORD}
      DB_NAME: wiki
    x-provelox:
      expose: true
      port: 3000
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: wiki
      POSTGRES_USER: wiki
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:
`,
  },
  {
    id: 'memos',
    icon: '/brands/memos.svg',
    name: 'Memos',
    description: `A lightweight place for quick notes and snippets.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'memos',
    port: 5230,
    publicWeb: true,
    variables: [],
    compose: `services:
  memos:
    image: neosmemo/memos:stable
    restart: unless-stopped
    volumes:
      - data:/var/opt/memos
    x-provelox:
      expose: true
      port: 5230
volumes:
  data:
`,
  },

  // ---- Security
  {
    id: 'vaultwarden',
    icon: 'vaultwarden',
    name: 'Vaultwarden',
    description:
      'A small, Bitwarden-compatible password manager server. Works with the Bitwarden apps and browser extensions.',
    category: 'Security',
    mainService: 'vaultwarden',
    port: 80,
    publicWeb: true,
    variables: [
      secret(
        'ADMIN_TOKEN',
        'Admin page token',
        'Opens the /admin page. Keep it private.',
      ),
      text(
        'SIGNUPS_ALLOWED',
        'Allow sign-ups',
        'true',
        'Set to false after you and your people have created accounts.',
      ),
    ],
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      ADMIN_TOKEN: \${ADMIN_TOKEN}
      SIGNUPS_ALLOWED: \${SIGNUPS_ALLOWED}
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 80
volumes:
  data:
`,
  },
  {
    id: 'keycloak',
    icon: 'keycloak',
    name: 'Keycloak',
    description:
      'Single sign-on and identity management (OpenID Connect, SAML) on PostgreSQL, with an admin account created for you.',
    category: 'Security',
    mainService: 'keycloak',
    port: 8080,
    publicWeb: true,
    variables: [
      text(
        'KC_HOSTNAME',
        'Public address',
        undefined,
        'The full address it will be opened at, for example https://login.example.com',
      ),
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
      dbPassword,
    ],
    compose: `services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    restart: unless-stopped
    depends_on: [db]
    command: start
    environment:
      KC_HOSTNAME: \${KC_HOSTNAME}
      KC_HTTP_ENABLED: "true"
      KC_PROXY_HEADERS: xforwarded
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://db:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: \${DB_PASSWORD}
      KC_BOOTSTRAP_ADMIN_USERNAME: \${ADMIN_USER}
      KC_BOOTSTRAP_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    x-provelox:
      expose: true
      port: 8080
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:
`,
  },

  // ---- Analytics and monitoring
  {
    id: 'metabase',
    icon: 'metabase',
    name: 'Metabase',
    description: `Business intelligence: ask questions of your data and build dashboards without SQL.${FIRST_VISIT}`,
    category: 'Analytics',
    mainService: 'metabase',
    port: 3000,
    publicWeb: true,
    variables: [dbPassword],
    compose: `services:
  metabase:
    image: metabase/metabase:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      MB_DB_TYPE: postgres
      MB_DB_HOST: db
      MB_DB_PORT: "5432"
      MB_DB_DBNAME: metabase
      MB_DB_USER: metabase
      MB_DB_PASS: \${DB_PASSWORD}
    x-provelox:
      expose: true
      port: 3000
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: metabase
      POSTGRES_USER: metabase
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:
`,
  },
  {
    id: 'grafana',
    icon: 'grafana',
    name: 'Grafana',
    description:
      'Dashboards and alerts for metrics, logs and databases, with an admin account created for you.',
    category: 'Monitoring',
    mainService: 'grafana',
    port: 3000,
    publicWeb: true,
    variables: [
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
    ],
    compose: `services:
  grafana:
    image: grafana/grafana-oss:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: \${ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/var/lib/grafana
    x-provelox:
      expose: true
      port: 3000
volumes:
  data:
`,
  },

  // ---- Development
  {
    id: 'gitea',
    icon: 'gitea',
    name: 'Gitea',
    description: `A self-hosted Git service with issues and pull requests, using a built-in database. Git over HTTPS only.${FIRST_VISIT}`,
    category: 'Development',
    mainService: 'gitea',
    port: 3000,
    publicWeb: true,
    variables: [],
    compose: `services:
  gitea:
    image: gitea/gitea:1
    restart: unless-stopped
    environment:
      GITEA__database__DB_TYPE: sqlite3
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 3000
volumes:
  data:
`,
  },

  // ---- AI
  {
    id: 'open-webui',
    icon: '/brands/openwebui.svg',
    name: 'Open WebUI',
    description: `A chat interface for language models: connect it to any OpenAI-compatible API.${FIRST_VISIT} The first account becomes the admin.`,
    category: 'AI',
    mainService: 'open-webui',
    port: 8080,
    publicWeb: true,
    variables: [secret('WEBUI_SECRET_KEY', 'Secret key')],
    compose: `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    environment:
      WEBUI_SECRET_KEY: \${WEBUI_SECRET_KEY}
    volumes:
      - data:/app/backend/data
    x-provelox:
      expose: true
      port: 8080
volumes:
  data:
`,
  },
  {
    id: 'langflow',
    icon: 'langflow',
    name: 'Langflow',
    description:
      'Build AI agents and workflows visually. Sign in with the admin account created for you.',
    category: 'AI',
    mainService: 'langflow',
    port: 7860,
    publicWeb: true,
    variables: [
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
      secret('SECRET_KEY', 'Secret key'),
    ],
    compose: `services:
  langflow:
    image: langflowai/langflow:latest
    restart: unless-stopped
    environment:
      LANGFLOW_AUTO_LOGIN: "false"
      LANGFLOW_SUPERUSER: \${ADMIN_USER}
      LANGFLOW_SUPERUSER_PASSWORD: \${ADMIN_PASSWORD}
      LANGFLOW_SECRET_KEY: \${SECRET_KEY}
    volumes:
      - data:/app/langflow
    x-provelox:
      expose: true
      port: 7860
volumes:
  data:
`,
  },
  {
    id: 'anythingllm',
    icon: '/brands/anythingllm.png',
    name: 'AnythingLLM',
    description:
      'Chat with your documents using any language model. Protected by the access password you choose.',
    category: 'AI',
    mainService: 'anythingllm',
    port: 3001,
    publicWeb: true,
    variables: [
      secret('AUTH_TOKEN', 'Access password'),
      secret('JWT_SECRET', 'Signing secret'),
    ],
    compose: `services:
  anythingllm:
    image: mintplexlabs/anythingllm:latest
    restart: unless-stopped
    environment:
      STORAGE_DIR: /app/server/storage
      AUTH_TOKEN: \${AUTH_TOKEN}
      JWT_SECRET: \${JWT_SECRET}
    volumes:
      - storage:/app/server/storage
    x-provelox:
      expose: true
      port: 3001
volumes:
  storage:
`,
  },

  // ---- Data
  {
    id: 'clickhouse',
    icon: 'clickhouse',
    name: 'ClickHouse',
    description:
      'A fast column-oriented database for analytics. Data is kept on a volume.',
    category: 'Database',
    mainService: 'clickhouse',
    port: 8123,
    connect:
      'http://{CLICKHOUSE_USER}:{CLICKHOUSE_PASSWORD}@{host}:{port}/?database={CLICKHOUSE_DB}',
    publicWeb: false,
    variables: [
      text('CLICKHOUSE_USER', 'Username', 'default'),
      text('CLICKHOUSE_DB', 'Database name', 'app'),
      secret('CLICKHOUSE_PASSWORD', 'Password'),
    ],
    compose: `services:
  clickhouse:
    image: clickhouse/clickhouse-server:latest
    restart: unless-stopped
    environment:
      CLICKHOUSE_USER: \${CLICKHOUSE_USER}
      CLICKHOUSE_PASSWORD: \${CLICKHOUSE_PASSWORD}
      CLICKHOUSE_DB: \${CLICKHOUSE_DB}
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
    volumes:
      - data:/var/lib/clickhouse
volumes:
  data:
`,
  },
  {
    id: 'meilisearch',
    icon: 'meilisearch',
    name: 'Meilisearch',
    description:
      'Fast, typo-tolerant search for your site or app, protected by a master key.',
    category: 'Database',
    mainService: 'meilisearch',
    port: 7700,
    connect: 'http://{host}:{port} (key: {MEILI_MASTER_KEY})',
    publicWeb: false,
    variables: [
      secret(
        'MEILI_MASTER_KEY',
        'Master key',
        'At least 16 characters. Use it to create narrower keys for your app.',
      ),
    ],
    compose: `services:
  meilisearch:
    image: getmeili/meilisearch:v1
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: \${MEILI_MASTER_KEY}
      MEILI_ENV: production
    volumes:
      - data:/meili_data
volumes:
  data:
`,
  },

  // ---- More
  {
    id: 'strapi',
    icon: 'strapi',
    name: 'Strapi',
    description:
      'A headless CMS with an admin panel and a REST and GraphQL API, on PostgreSQL. A community-packaged image (Elestio): an empty Strapi to start from. To run your own content types, build your project into an image and deploy it with a Compose file.',
    category: 'CMS',
    mainService: 'strapi',
    port: 1337,
    publicWeb: true,
    variables: [
      secret('APP_KEYS', 'App keys'),
      secret('API_TOKEN_SALT', 'API token salt'),
      secret('ADMIN_JWT_SECRET', 'Admin signing secret'),
      secret('TRANSFER_TOKEN_SALT', 'Transfer token salt'),
      secret('JWT_SECRET', 'Signing secret'),
      dbPassword,
    ],
    compose: `services:
  strapi:
    image: elestio/strapi-production:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      NODE_ENV: production
      DATABASE_CLIENT: postgres
      DATABASE_HOST: db
      DATABASE_PORT: "5432"
      DATABASE_NAME: strapi
      DATABASE_USERNAME: strapi
      DATABASE_PASSWORD: \${DB_PASSWORD}
      APP_KEYS: \${APP_KEYS}
      API_TOKEN_SALT: \${API_TOKEN_SALT}
      ADMIN_JWT_SECRET: \${ADMIN_JWT_SECRET}
      TRANSFER_TOKEN_SALT: \${TRANSFER_TOKEN_SALT}
      JWT_SECRET: \${JWT_SECRET}
    volumes:
      - uploads:/opt/app/public/uploads
    x-provelox:
      expose: true
      port: 1337
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: strapi
      POSTGRES_USER: strapi
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  uploads:
  dbdata:
`,
  },
  {
    id: 'baserow',
    icon: 'baserow',
    name: 'Baserow',
    description: `An open Airtable alternative: build databases and apps without code.${FIRST_VISIT}`,
    category: 'Automation',
    mainService: 'baserow',
    port: 80,
    publicWeb: true,
    variables: [
      text(
        'BASEROW_PUBLIC_URL',
        'Public address',
        undefined,
        'The address it will be opened at, for example https://tables.example.com',
      ),
      secret('SECRET_KEY', 'Secret key'),
    ],
    compose: `services:
  baserow:
    image: baserow/baserow:latest
    restart: unless-stopped
    environment:
      BASEROW_PUBLIC_URL: \${BASEROW_PUBLIC_URL}
      SECRET_KEY: \${SECRET_KEY}
    volumes:
      - data:/baserow/data
    x-provelox:
      expose: true
      port: 80
volumes:
  data:
`,
  },
  {
    id: 'odoo',
    icon: 'odoo',
    name: 'Odoo',
    description: `Business apps in one place: CRM, sales, invoicing, inventory and more, on PostgreSQL. The first page creates your database.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'odoo',
    port: 8069,
    publicWeb: true,
    variables: [dbPassword],
    compose: `services:
  odoo:
    image: odoo:18
    restart: unless-stopped
    depends_on: [db]
    environment:
      HOST: db
      USER: odoo
      PASSWORD: \${DB_PASSWORD}
    volumes:
      - data:/var/lib/odoo
    x-provelox:
      expose: true
      port: 8069
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: odoo
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  data:
  dbdata:
`,
  },
  {
    id: 'matomo',
    icon: 'matomo',
    name: 'Matomo',
    description: `Web analytics you own, a privacy-friendly alternative to Google Analytics, on MariaDB.${FIRST_VISIT}`,
    category: 'Analytics',
    mainService: 'matomo',
    port: 80,
    publicWeb: true,
    variables: [
      dbPassword,
      secret('DB_ROOT_PASSWORD', 'Database root password'),
    ],
    compose: `services:
  matomo:
    image: matomo:5
    restart: unless-stopped
    depends_on: [db]
    environment:
      MATOMO_DATABASE_HOST: db
      MATOMO_DATABASE_ADAPTER: mysql
      MATOMO_DATABASE_USERNAME: matomo
      MATOMO_DATABASE_PASSWORD: \${DB_PASSWORD}
      MATOMO_DATABASE_DBNAME: matomo
    volumes:
      - html:/var/www/html
    x-provelox:
      expose: true
      port: 80
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: matomo
      MARIADB_USER: matomo
      MARIADB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - dbdata:/var/lib/mysql
volumes:
  html:
  dbdata:
`,
  },
  {
    id: 'ollama',
    icon: 'ollama',
    name: 'Ollama',
    description:
      'Run open language models on this server (CPU). Other apps, such as Open WebUI, connect to it privately. It has no login, so it is not published to the internet.',
    category: 'AI',
    mainService: 'ollama',
    port: 11434,
    connect: 'http://{host}:{port}',
    publicWeb: false,
    variables: [],
    compose: `services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - models:/root/.ollama
volumes:
  models:
`,
  },
  {
    id: 'qdrant',
    icon: 'qdrant',
    name: 'Qdrant',
    description:
      'A vector database for search and AI apps, protected by an API key.',
    category: 'Database',
    mainService: 'qdrant',
    port: 6333,
    connect: 'http://{host}:{port} (api-key: {API_KEY})',
    publicWeb: false,
    variables: [secret('API_KEY', 'API key')],
    compose: `services:
  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    environment:
      QDRANT__SERVICE__API_KEY: \${API_KEY}
    volumes:
      - storage:/qdrant/storage
volumes:
  storage:
`,
  },
  {
    id: 'rabbitmq',
    icon: 'rabbitmq',
    name: 'RabbitMQ',
    description:
      'A message broker for queues and background jobs, with a user and password you choose.',
    category: 'Database',
    mainService: 'rabbitmq',
    port: 5672,
    connect: 'amqp://{RABBITMQ_USER}:{RABBITMQ_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [
      text('RABBITMQ_USER', 'Username', 'app'),
      secret('RABBITMQ_PASSWORD', 'Password'),
    ],
    compose: `services:
  rabbitmq:
    image: rabbitmq:4-management
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_USER}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD}
      # the data directory is named after the node: a fixed name keeps it when the container is recreated
      RABBITMQ_NODENAME: rabbit@localhost
    volumes:
      - data:/var/lib/rabbitmq
volumes:
  data:
`,
  },
  {
    id: 'mailpit',
    icon: '/brands/mailpit.svg',
    name: 'Mailpit',
    description:
      'Catches the email your apps send while you build them, with a web inbox to read it. Apps send to it on port 1025.',
    category: 'Development',
    mainService: 'mailpit',
    port: 8025,
    publicWeb: true,
    variables: [
      text('MAIL_USER', 'Inbox username', 'admin'),
      secret('MAIL_PASSWORD', 'Inbox password'),
    ],
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    environment:
      MP_UI_AUTH: "\${MAIL_USER}:\${MAIL_PASSWORD}"
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
      MP_DATABASE: /data/mailpit.db
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 8025
volumes:
  data:
`,
  },
  {
    id: 'excalidraw',
    icon: 'excalidraw',
    name: 'Excalidraw',
    description:
      "A virtual whiteboard for sketching diagrams with a hand-drawn look. Drawings stay in each visitor's browser.",
    category: 'Productivity',
    mainService: 'excalidraw',
    port: 80,
    publicWeb: true,
    variables: [],
    compose: `services:
  excalidraw:
    image: excalidraw/excalidraw:latest
    restart: unless-stopped
    x-provelox:
      expose: true
      port: 80
`,
  },
  {
    id: 'it-tools',
    icon: '/brands/ittools.png',
    name: 'IT-Tools',
    description:
      'Handy tools for developers and IT people: converters, generators, encoders and more. Everything runs in the browser.',
    category: 'Tools',
    mainService: 'it-tools',
    port: 80,
    publicWeb: true,
    variables: [],
    compose: `services:
  it-tools:
    image: corentinth/it-tools:latest
    restart: unless-stopped
    x-provelox:
      expose: true
      port: 80
`,
  },
  {
    id: 'stirling-pdf',
    icon: '/brands/stirlingpdf.svg',
    name: 'Stirling PDF',
    description:
      'Merge, split, convert, compress and sign PDFs from a web page, on your own server.',
    category: 'Tools',
    mainService: 'stirling-pdf',
    port: 8080,
    publicWeb: true,
    variables: [],
    compose: `services:
  stirling-pdf:
    image: stirlingtools/stirling-pdf:latest
    restart: unless-stopped
    volumes:
      - tessdata:/usr/share/tessdata
      - configs:/configs
    x-provelox:
      expose: true
      port: 8080
volumes:
  tessdata:
  configs:
`,
  },
  {
    id: 'actual-budget',
    icon: 'actualbudget',
    name: 'Actual Budget',
    description: `A private, local-first budgeting app that syncs across your devices.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'actual',
    port: 5006,
    publicWeb: true,
    variables: [],
    compose: `services:
  actual:
    image: actualbudget/actual-server:latest
    restart: unless-stopped
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 5006
volumes:
  data:
`,
  },
  {
    id: 'mealie',
    icon: 'mealie',
    name: 'Mealie',
    description:
      'A recipe manager and meal planner. Sign in with the admin account created for you.',
    category: 'Productivity',
    mainService: 'mealie',
    port: 9000,
    publicWeb: true,
    variables: [adminEmail, adminPassword],
    compose: `services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:latest
    restart: unless-stopped
    environment:
      ALLOW_SIGNUP: "false"
      DEFAULT_EMAIL: \${ADMIN_EMAIL}
      DEFAULT_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/app/data
    x-provelox:
      expose: true
      port: 9000
volumes:
  data:
`,
  },
  {
    id: 'linkding',
    icon: '/brands/linkding.svg',
    name: 'Linkding',
    description:
      'A minimal bookmark manager with tags and search, with an admin account created for you.',
    category: 'Productivity',
    mainService: 'linkding',
    port: 9090,
    publicWeb: true,
    variables: [
      text('ADMIN_USER', 'Admin username', 'admin'),
      secret('ADMIN_PASSWORD', 'Admin password'),
    ],
    compose: `services:
  linkding:
    image: sissbruecker/linkding:latest
    restart: unless-stopped
    environment:
      LD_SUPERUSER_NAME: \${ADMIN_USER}
      LD_SUPERUSER_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/etc/linkding/data
    x-provelox:
      expose: true
      port: 9090
volumes:
  data:
`,
  },

  // ---- Documents, tasks and reading
  {
    id: 'docuseal',
    icon: '/brands/docuseal.svg',
    name: 'DocuSeal',
    description: `Create, fill and sign documents online: an open alternative to DocuSign.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'docuseal',
    port: 3000,
    publicWeb: true,
    variables: [secret('SECRET_KEY_BASE', 'Secret key')],
    compose: `services:
  docuseal:
    image: docuseal/docuseal:latest
    restart: unless-stopped
    environment:
      SECRET_KEY_BASE: \${SECRET_KEY_BASE}
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 3000
volumes:
  data:
`,
  },
  {
    id: 'firefly-iii',
    icon: 'fireflyiii',
    name: 'Firefly III',
    description: `Personal finance manager: track spending, budgets and accounts, on PostgreSQL.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'firefly',
    port: 8080,
    publicWeb: true,
    variables: [
      publicUrl('https://money.example.com'),
      adminEmail,
      {
        ...secret(
          'APP_KEY',
          'App key',
          'Exactly 32 characters. Keep it: data is encrypted with it.',
        ),
        minLength: 32,
      },
      dbPassword,
    ],
    compose: `services:
  firefly:
    image: fireflyiii/core:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      APP_KEY: \${APP_KEY}
      APP_URL: \${PUBLIC_URL}
      SITE_OWNER: \${ADMIN_EMAIL}
      TRUSTED_PROXIES: "**"
      DB_CONNECTION: pgsql
      DB_HOST: db
      DB_PORT: "5432"
      DB_DATABASE: firefly
      DB_USERNAME: firefly
      DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - upload:/var/www/html/storage/upload
    x-provelox:
      expose: true
      port: 8080
${postgres('firefly')}volumes:
  upload:
  dbdata:
`,
  },
  {
    id: 'freshrss',
    icon: 'freshrss',
    name: 'FreshRSS',
    description: `A self-hosted feed reader that keeps your subscriptions and read state in one place.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'freshrss',
    port: 80,
    publicWeb: true,
    variables: [],
    compose: `services:
  freshrss:
    image: freshrss/freshrss:latest
    restart: unless-stopped
    environment:
      CRON_MIN: "1,31"
      TZ: UTC
    volumes:
      - data:/var/www/FreshRSS/data
      - extensions:/var/www/FreshRSS/extensions
    x-provelox:
      expose: true
      port: 80
volumes:
  data:
  extensions:
`,
  },
  {
    id: 'miniflux',
    icon: '/brands/miniflux.png',
    name: 'Miniflux',
    description:
      'A minimalist, fast feed reader, on PostgreSQL, with an admin account created for you.',
    category: 'Productivity',
    mainService: 'miniflux',
    port: 8080,
    publicWeb: true,
    variables: [adminUser, adminPassword, dbPassword],
    compose: `services:
  miniflux:
    image: miniflux/miniflux:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      DATABASE_URL: "postgres://miniflux:\${DB_PASSWORD}@db/miniflux?sslmode=disable"
      RUN_MIGRATIONS: "1"
      CREATE_ADMIN: "1"
      ADMIN_USERNAME: \${ADMIN_USER}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    x-provelox:
      expose: true
      port: 8080
${postgres('miniflux')}volumes:
  dbdata:
`,
  },
  {
    id: 'linkwarden',
    icon: '/brands/linkwarden.png',
    name: 'Linkwarden',
    description: `Save, organize and archive links and pages, with your collections in one place, on PostgreSQL.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'linkwarden',
    port: 3000,
    publicWeb: true,
    variables: [
      publicUrl('https://links.example.com'),
      secret('NEXTAUTH_SECRET', 'Sign-in secret'),
      dbPassword,
    ],
    compose: `services:
  linkwarden:
    image: ghcr.io/linkwarden/linkwarden:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      DATABASE_URL: "postgresql://linkwarden:\${DB_PASSWORD}@db:5432/linkwarden"
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: "\${PUBLIC_URL}/api/v1/auth"
    volumes:
      - data:/data/data
    x-provelox:
      expose: true
      port: 3000
${postgres('linkwarden')}volumes:
  data:
  dbdata:
`,
  },
  {
    id: 'shlink',
    icon: '/brands/shlink.svg',
    name: 'Shlink',
    description:
      "A URL shortener with visit statistics and an API, on PostgreSQL. Manage it with the API key you set, from Shlink's web client or its API.",
    category: 'Tools',
    mainService: 'shlink',
    port: 8080,
    publicWeb: true,
    variables: [
      text(
        'DEFAULT_DOMAIN',
        'Short domain',
        undefined,
        'The domain short links use, without https://, for example go.example.com',
      ),
      secret('API_KEY', 'API key'),
      dbPassword,
    ],
    compose: `services:
  shlink:
    image: shlinkio/shlink:stable
    restart: unless-stopped
    depends_on: [db]
    environment:
      DEFAULT_DOMAIN: \${DEFAULT_DOMAIN}
      IS_HTTPS_ENABLED: "true"
      INITIAL_API_KEY: \${API_KEY}
      DB_DRIVER: postgres
      DB_HOST: db
      DB_NAME: shlink
      DB_USER: shlink
      DB_PASSWORD: \${DB_PASSWORD}
    x-provelox:
      expose: true
      port: 8080
${postgres('shlink')}volumes:
  dbdata:
`,
  },
  {
    id: 'yourls',
    icon: '/brands/yourls.svg',
    name: 'YOURLS',
    description:
      'Your own URL shortener with statistics, on MariaDB. Sign in with the admin account created for you.',
    category: 'Tools',
    mainService: 'yourls',
    port: 80,
    publicWeb: true,
    variables: [
      publicUrl('https://go.example.com'),
      adminUser,
      adminPassword,
      dbPassword,
      dbRootPassword,
    ],
    compose: `services:
  yourls:
    image: yourls:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      YOURLS_SITE: \${PUBLIC_URL}
      YOURLS_USER: \${ADMIN_USER}
      YOURLS_PASS: \${ADMIN_PASSWORD}
      YOURLS_DB_HOST: db
      YOURLS_DB_NAME: yourls
      YOURLS_DB_USER: yourls
      YOURLS_DB_PASS: \${DB_PASSWORD}
    x-provelox:
      expose: true
      port: 80
${mariadb('yourls')}volumes:
  dbdata:
`,
  },
  {
    id: 'privatebin',
    icon: '/brands/privatebin.svg',
    name: 'PrivateBin',
    description:
      'A paste service where the server never sees what is shared: it is encrypted in the browser.',
    category: 'Tools',
    mainService: 'privatebin',
    port: 8080,
    publicWeb: true,
    variables: [],
    compose: `services:
  privatebin:
    image: privatebin/nginx-fpm-alpine:latest
    restart: unless-stopped
    volumes:
      - data:/srv/data
    x-provelox:
      expose: true
      port: 8080
volumes:
  data:
`,
  },
  {
    id: 'drawio',
    icon: 'diagramsdotnet',
    name: 'draw.io',
    description:
      'A diagram editor for flowcharts, network maps and UML. Diagrams are saved to your own device.',
    category: 'Productivity',
    mainService: 'drawio',
    port: 8080,
    publicWeb: true,
    variables: [],
    compose: `services:
  drawio:
    image: jgraph/drawio:latest
    restart: unless-stopped
    x-provelox:
      expose: true
      port: 8080
`,
  },
  {
    id: 'homebox',
    icon: '/brands/homebox.svg',
    name: 'Homebox',
    description: `An inventory for your home: track belongings, warranties and where things are kept.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'homebox',
    port: 7745,
    publicWeb: true,
    variables: [],
    compose: `services:
  homebox:
    image: ghcr.io/sysadminsmedia/homebox:latest
    restart: unless-stopped
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 7745
volumes:
  data:
`,
  },
  {
    id: 'photoprism',
    icon: '/brands/photoprism.svg',
    name: 'PhotoPrism',
    description:
      'Browse, organize and search your photos with automatic tagging. Upload from the web page. Sign in with the admin account created for you.',
    category: 'Productivity',
    mainService: 'photoprism',
    port: 2342,
    publicWeb: true,
    variables: [adminUser, adminPassword],
    compose: `services:
  photoprism:
    image: photoprism/photoprism:latest
    restart: unless-stopped
    environment:
      PHOTOPRISM_ADMIN_USER: \${ADMIN_USER}
      PHOTOPRISM_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      PHOTOPRISM_DATABASE_DRIVER: sqlite
    volumes:
      - storage:/photoprism/storage
      - originals:/photoprism/originals
    x-provelox:
      expose: true
      port: 2342
volumes:
  storage:
  originals:
`,
  },
  {
    id: 'audiobookshelf',
    icon: 'audiobookshelf',
    name: 'Audiobookshelf',
    description: `Host and listen to your audiobooks and podcasts, with apps for phones.${FIRST_VISIT}`,
    category: 'Productivity',
    mainService: 'audiobookshelf',
    port: 80,
    publicWeb: true,
    variables: [],
    compose: `services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:latest
    restart: unless-stopped
    volumes:
      - config:/config
      - metadata:/metadata
      - audiobooks:/audiobooks
      - podcasts:/podcasts
    x-provelox:
      expose: true
      port: 80
volumes:
  config:
  metadata:
  audiobooks:
  podcasts:
`,
  },

  // ---- Developer and admin tools
  {
    id: 'gitlab',
    icon: 'gitlab',
    name: 'GitLab',
    description:
      'The full GitLab Community Edition: repositories, issues, merge requests and CI. Needs about 4 GB of memory and a few minutes to start. Git over HTTPS only. Sign in as root with the password you set.',
    category: 'Development',
    mainService: 'gitlab',
    port: 80,
    publicWeb: true,
    variables: [
      text(
        'GITLAB_URL',
        'Public address',
        undefined,
        'The full address it will be opened at, for example https://git.example.com',
      ),
      secret('ROOT_PASSWORD', 'Root password'),
    ],
    compose: `services:
  gitlab:
    image: gitlab/gitlab-ce:latest
    restart: unless-stopped
    environment:
      GITLAB_ROOT_PASSWORD: \${ROOT_PASSWORD}
      GITLAB_OMNIBUS_CONFIG: "external_url '\${GITLAB_URL}'; letsencrypt['enable'] = false; nginx['listen_port'] = 80; nginx['listen_https'] = false"
    volumes:
      - config:/etc/gitlab
      - logs:/var/log/gitlab
      - data:/var/opt/gitlab
    x-provelox:
      expose: true
      port: 80
volumes:
  config:
  logs:
  data:
`,
  },
  {
    id: 'pgadmin',
    icon: '/brands/pgadmin.png',
    name: 'pgAdmin',
    description:
      'The standard web tool for managing PostgreSQL databases. Add a server with the host shown on its project.',
    category: 'Tools',
    mainService: 'pgadmin',
    port: 80,
    publicWeb: true,
    variables: [adminEmail, adminPassword],
    compose: `services:
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: \${ADMIN_EMAIL}
      PGADMIN_DEFAULT_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/var/lib/pgadmin
    x-provelox:
      expose: true
      port: 80
volumes:
  data:
`,
  },
  {
    id: 'phpmyadmin',
    icon: 'phpmyadmin',
    name: 'phpMyAdmin',
    description:
      "The classic web tool for managing MySQL and MariaDB databases. Type the host shown on the database's project to sign in.",
    category: 'Tools',
    mainService: 'phpmyadmin',
    port: 80,
    publicWeb: true,
    variables: [
      text(
        'DB_HOST',
        'Database host',
        undefined,
        "The host shown on the database's project page, for example myproject-mysql. Only this one is reachable from the page.",
      ),
    ],
    compose: `services:
  phpmyadmin:
    image: phpmyadmin:latest
    restart: unless-stopped
    environment:
      PMA_HOST: \${DB_HOST}
    x-provelox:
      expose: true
      port: 80
`,
  },
  {
    id: 'healthchecks',
    icon: '/brands/healthchecks.svg',
    name: 'Healthchecks',
    description:
      'Monitors your cron jobs and scheduled tasks: they ping it, and it alerts you when a ping is missing. Sign in with the admin account created for you.',
    category: 'Monitoring',
    mainService: 'healthchecks',
    port: 8000,
    publicWeb: true,
    variables: [
      publicUrl('https://checks.example.com'),
      adminEmail,
      adminPassword,
      secret('SECRET_KEY', 'Secret key'),
    ],
    compose: `services:
  healthchecks:
    image: healthchecks/healthchecks:latest
    restart: unless-stopped
    environment:
      SECRET_KEY: \${SECRET_KEY}
      SITE_ROOT: \${PUBLIC_URL}
      ALLOWED_HOSTS: "*"
      DB: sqlite
      DB_NAME: /data/hc.sqlite
      REGISTRATION_OPEN: "False"
      SUPERUSER_EMAIL: \${ADMIN_EMAIL}
      SUPERUSER_PASSWORD: \${ADMIN_PASSWORD}
      DEFAULT_FROM_EMAIL: \${ADMIN_EMAIL}
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 8000
volumes:
  data:
`,
  },
  {
    id: 'gotify',
    icon: '/brands/gotify.png',
    name: 'Gotify',
    description:
      'A simple server for sending and receiving push notifications, with an admin account created for you.',
    category: 'Tools',
    mainService: 'gotify',
    port: 80,
    publicWeb: true,
    variables: [adminUser, adminPassword],
    compose: `services:
  gotify:
    image: gotify/server:latest
    restart: unless-stopped
    environment:
      GOTIFY_DEFAULTUSER_NAME: \${ADMIN_USER}
      GOTIFY_DEFAULTUSER_PASS: \${ADMIN_PASSWORD}
    volumes:
      - data:/app/data
    x-provelox:
      expose: true
      port: 80
volumes:
  data:
`,
  },
  {
    id: 'listmonk',
    icon: 'listmonk',
    name: 'Listmonk',
    description:
      'Newsletters and mailing lists: a fast, self-hosted way to send email to your subscribers, on PostgreSQL. Sign in with the admin account created for you.',
    category: 'Productivity',
    mainService: 'listmonk',
    port: 9000,
    publicWeb: true,
    variables: [adminUser, adminPassword, dbPassword],
    compose: `services:
  listmonk:
    image: listmonk/listmonk:latest
    restart: unless-stopped
    depends_on: [db]
    command: sh -c "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"
    environment:
      LISTMONK_app__address: "0.0.0.0:9000"
      LISTMONK_db__host: db
      LISTMONK_db__port: "5432"
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: \${DB_PASSWORD}
      LISTMONK_db__database: listmonk
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: \${ADMIN_USER}
      LISTMONK_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - uploads:/listmonk/uploads
    x-provelox:
      expose: true
      port: 9000
${postgres('listmonk')}volumes:
  uploads:
  dbdata:
`,
  },
  {
    id: 'litellm',
    icon: '/brands/litellm.png',
    name: 'LiteLLM',
    description:
      'One OpenAI-compatible gateway to many AI model providers, with keys, budgets and usage tracking, on PostgreSQL. Your master key is "sk-" followed by the value below. The admin page is at /ui.',
    category: 'AI',
    mainService: 'litellm',
    port: 4000,
    publicWeb: true,
    variables: [
      secret('MASTER_KEY', 'Master key'),
      adminUser,
      adminPassword,
      dbPassword,
    ],
    compose: `services:
  litellm:
    image: ghcr.io/berriai/litellm:main-stable
    restart: unless-stopped
    depends_on: [db]
    environment:
      LITELLM_MASTER_KEY: "sk-\${MASTER_KEY}"
      DATABASE_URL: "postgresql://litellm:\${DB_PASSWORD}@db:5432/litellm"
      STORE_MODEL_IN_DB: "True"
      UI_USERNAME: \${ADMIN_USER}
      UI_PASSWORD: \${ADMIN_PASSWORD}
    x-provelox:
      expose: true
      port: 4000
${postgres('litellm')}volumes:
  dbdata:
`,
  },

  // ---- Commerce
  {
    id: 'prestashop',
    icon: 'prestashop',
    name: 'PrestaShop',
    description:
      'An online shop: catalog, orders, payments and shipping, on MariaDB. Installs itself on first start (a few minutes). The admin panel is at /admin-panel.',
    category: 'Commerce',
    mainService: 'prestashop',
    port: 80,
    publicWeb: true,
    variables: [
      text(
        'PS_DOMAIN',
        'Domain',
        undefined,
        'The domain the shop will be opened on, without https://, for example shop.example.com',
      ),
      adminEmail,
      adminPassword,
      dbPassword,
      dbRootPassword,
    ],
    compose: `services:
  prestashop:
    image: prestashop/prestashop:latest
    restart: unless-stopped
    depends_on: [db]
    environment:
      DB_SERVER: db
      DB_NAME: prestashop
      DB_USER: prestashop
      DB_PASSWD: \${DB_PASSWORD}
      PS_INSTALL_AUTO: "1"
      PS_DOMAIN: \${PS_DOMAIN}
      PS_ENABLE_SSL: "1"
      PS_FOLDER_ADMIN: admin-panel
      PS_FOLDER_INSTALL: install-done
      ADMIN_MAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWD: \${ADMIN_PASSWORD}
    volumes:
      - html:/var/www/html
    x-provelox:
      expose: true
      port: 80
${mariadb('prestashop')}volumes:
  html:
  dbdata:
`,
  },

  // ---- Databases and data services
  {
    id: 'mariadb',
    icon: 'mariadb',
    name: 'MariaDB',
    description:
      'MariaDB 11 with a database created for you. Data is kept on a volume.',
    category: 'Database',
    mainService: 'mariadb',
    port: 3306,
    connect:
      'mysql://root:{MARIADB_ROOT_PASSWORD}@{host}:{port}/{MARIADB_DATABASE}',
    publicWeb: false,
    variables: [
      text('MARIADB_DATABASE', 'Database name', 'app'),
      secret('MARIADB_ROOT_PASSWORD', 'Root password'),
    ],
    compose: `services:
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${MARIADB_DATABASE}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
`,
  },
  {
    id: 'valkey',
    icon: '/brands/valkey.svg',
    name: 'Valkey',
    description:
      'The open-source Redis-compatible store for caches, queues and sessions, with a password and on-disk persistence.',
    category: 'Database',
    mainService: 'valkey',
    port: 6379,
    connect: 'redis://:{VALKEY_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [secret('VALKEY_PASSWORD', 'Password')],
    compose: `services:
  valkey:
    image: valkey/valkey:8
    restart: unless-stopped
    command: valkey-server --requirepass \${VALKEY_PASSWORD} --appendonly yes
    volumes:
      - data:/data
volumes:
  data:
`,
  },
  {
    id: 'timescaledb',
    icon: 'timescale',
    name: 'TimescaleDB',
    description:
      'PostgreSQL with time-series superpowers, for metrics, events and IoT data. Data is kept on a volume.',
    category: 'Database',
    mainService: 'timescaledb',
    port: 5432,
    connect:
      'postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{host}:{port}/{POSTGRES_DB}',
    publicWeb: false,
    variables: [
      text('POSTGRES_USER', 'Username', 'postgres'),
      text('POSTGRES_DB', 'Database name', 'app'),
      secret('POSTGRES_PASSWORD', 'Password'),
    ],
    compose: `services:
  timescaledb:
    image: timescale/timescaledb:latest-pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
`,
  },
  {
    id: 'influxdb',
    icon: 'influxdb',
    name: 'InfluxDB',
    description:
      'A time-series database for metrics and sensor data, with a web interface. Sign in with the admin account created for you.',
    category: 'Database',
    mainService: 'influxdb',
    port: 8086,
    publicWeb: true,
    variables: [
      adminUser,
      adminPassword,
      text('ORG', 'Organization', 'my-org'),
      text('BUCKET', 'First bucket', 'default'),
      secret('ADMIN_TOKEN', 'Admin API token'),
    ],
    compose: `services:
  influxdb:
    image: influxdb:2
    restart: unless-stopped
    environment:
      DOCKER_INFLUXDB_INIT_MODE: setup
      DOCKER_INFLUXDB_INIT_USERNAME: \${ADMIN_USER}
      DOCKER_INFLUXDB_INIT_PASSWORD: \${ADMIN_PASSWORD}
      DOCKER_INFLUXDB_INIT_ORG: \${ORG}
      DOCKER_INFLUXDB_INIT_BUCKET: \${BUCKET}
      DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: \${ADMIN_TOKEN}
    volumes:
      - data:/var/lib/influxdb2
      - config:/etc/influxdb2
    x-provelox:
      expose: true
      port: 8086
volumes:
  data:
  config:
`,
  },
  {
    id: 'couchdb',
    icon: 'apachecouchdb',
    name: 'CouchDB',
    description:
      'A document database with a simple HTTP API and easy syncing. Data is kept on a volume.',
    category: 'Database',
    mainService: 'couchdb',
    port: 5984,
    connect: 'http://{COUCHDB_USER}:{COUCHDB_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [
      text('COUCHDB_USER', 'Admin username', 'admin'),
      secret('COUCHDB_PASSWORD', 'Admin password'),
    ],
    compose: `services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    environment:
      COUCHDB_USER: \${COUCHDB_USER}
      COUCHDB_PASSWORD: \${COUCHDB_PASSWORD}
    volumes:
      - data:/opt/couchdb/data
volumes:
  data:
`,
  },
  {
    id: 'neo4j',
    icon: 'neo4j',
    name: 'Neo4j',
    description:
      'A graph database for connected data. Apps connect over Bolt as the user "neo4j". Data is kept on a volume.',
    category: 'Database',
    mainService: 'neo4j',
    port: 7687,
    connect: 'bolt://neo4j:{NEO4J_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [secret('NEO4J_PASSWORD', 'Password')],
    compose: `services:
  neo4j:
    image: neo4j:5
    restart: unless-stopped
    environment:
      NEO4J_AUTH: "neo4j/\${NEO4J_PASSWORD}"
    volumes:
      - data:/data
volumes:
  data:
`,
  },
];
