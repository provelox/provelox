/**
 * Ready-made apps ("one-click apps"): curated Compose files with the few values a person has to choose. Deploying one
 * is the same as deploying that Compose file as a project, so everything a project does (private network, volumes
 * kept on removal, start order) applies. `${VAR}` references in `compose` are filled from `variables`.
 */
export interface TemplateVariable {
  key: string;
  label: string;
  description?: string;
  default?: string;
  /** "secret" values are generated for the user and hidden in the form */
  kind: 'text' | 'secret';
  /** The fewest characters the app accepts: a generated secret is at least this long, and a shorter value is refused */
  minLength?: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category:
    | 'Database'
    | 'Storage'
    | 'Web'
    | 'CMS'
    | 'Automation'
    | 'Productivity'
    | 'Security'
    | 'Analytics'
    | 'Monitoring'
    | 'Development'
    | 'Commerce'
    | 'AI'
    | 'Tools';
  /** The service other things connect to, so the console can say how (host: <project>-<this service>) */
  mainService: string;
  /** Port of that service, for connection hints */
  port?: number;
  /**
   * How another app connects, as a template: `{host}` and `{port}` are filled in, and `{VAR}` is the value chosen for
   * that variable. Missing for templates that are a web page to open instead.
   */
  connect?: string;
  /**
   * A logo the console has: a Simple Icons name bundled with it ("postgresql"), or a file in console/public/brands
   * ("/brands/ghost.svg"). Without one the card shows the template's initials.
   */
  icon?: string;
  /** True when the template makes a service reachable from the internet (a web page to open) */
  publicWeb: boolean;
  variables: TemplateVariable[];
  compose: string;
}

const secret = (
  key: string,
  label: string,
  description?: string,
): TemplateVariable => ({
  key,
  label,
  description,
  kind: 'secret',
});

import { APP_TEMPLATES } from './catalog-apps';

export const TEMPLATES: Template[] = [
  {
    id: 'postgres',
    icon: 'postgresql',
    name: 'PostgreSQL',
    description:
      'The popular relational database. Data is kept on a volume that survives redeploys.',
    category: 'Database',
    mainService: 'postgres',
    port: 5432,
    connect:
      'postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{host}:{port}/{POSTGRES_DB}',
    publicWeb: false,
    variables: [
      {
        key: 'POSTGRES_USER',
        label: 'Username',
        default: 'postgres',
        kind: 'text',
      },
      {
        key: 'POSTGRES_DB',
        label: 'Database name',
        default: 'app',
        kind: 'text',
      },
      secret('POSTGRES_PASSWORD', 'Password'),
    ],
    compose: `services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER}"]
      interval: 10s
      retries: 5
volumes:
  pgdata:
`,
  },
  {
    id: 'redis',
    icon: 'redis',
    name: 'Redis',
    description:
      'In-memory data store for caches, queues and sessions, with a password and on-disk persistence.',
    category: 'Database',
    mainService: 'redis',
    port: 6379,
    connect: 'redis://:{REDIS_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [secret('REDIS_PASSWORD', 'Password')],
    compose: `services:
  redis:
    image: redis:7
    restart: unless-stopped
    command: redis-server --requirepass \${REDIS_PASSWORD} --appendonly yes
    volumes:
      - data:/data
volumes:
  data:
`,
  },
  {
    id: 'mysql',
    icon: 'mysql',
    name: 'MySQL',
    description:
      'MySQL 8.4 with a database created for you. Data is kept on a volume.',
    category: 'Database',
    mainService: 'mysql',
    port: 3306,
    connect:
      'mysql://root:{MYSQL_ROOT_PASSWORD}@{host}:{port}/{MYSQL_DATABASE}',
    publicWeb: false,
    variables: [
      {
        key: 'MYSQL_DATABASE',
        label: 'Database name',
        default: 'app',
        kind: 'text',
      },
      secret('MYSQL_ROOT_PASSWORD', 'Root password'),
    ],
    compose: `services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: \${MYSQL_DATABASE}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
`,
  },
  {
    id: 'mongodb',
    icon: 'mongodb',
    name: 'MongoDB',
    description:
      'Document database with an admin user. Data is kept on a volume.',
    category: 'Database',
    mainService: 'mongo',
    port: 27017,
    connect: 'mongodb://{MONGO_USER}:{MONGO_PASSWORD}@{host}:{port}',
    publicWeb: false,
    variables: [
      {
        key: 'MONGO_USER',
        label: 'Admin username',
        default: 'admin',
        kind: 'text',
      },
      secret('MONGO_PASSWORD', 'Admin password'),
    ],
    compose: `services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD}
    volumes:
      - data:/data/db
volumes:
  data:
`,
  },
  {
    id: 'rustfs',
    icon: 'rustfs',
    name: 'RustFS',
    description:
      'S3-compatible object storage with a web console. Other apps use the S3 API on port 9000.',
    category: 'Storage',
    mainService: 'rustfs',
    port: 9000,
    connect: 'http://{host}:{port}',
    publicWeb: true,
    variables: [
      {
        key: 'RUSTFS_ACCESS_KEY',
        label: 'Access key',
        default: 'rustfsadmin',
        kind: 'text',
      },
      secret('RUSTFS_SECRET_KEY', 'Secret key', 'At least 8 characters.'),
    ],
    compose: `services:
  rustfs:
    image: rustfs/rustfs:latest
    restart: unless-stopped
    environment:
      RUSTFS_ACCESS_KEY: \${RUSTFS_ACCESS_KEY}
      RUSTFS_SECRET_KEY: \${RUSTFS_SECRET_KEY}
    volumes:
      - data:/data
    x-provelox:
      expose: true
      port: 9001
volumes:
  data:
`,
  },
  {
    id: 'uptime-kuma',
    icon: 'uptimekuma',
    name: 'Uptime Kuma',
    description:
      'A friendly self-hosted uptime monitor with status pages and notifications.',
    category: 'Monitoring',
    mainService: 'kuma',
    port: 3001,
    publicWeb: true,
    variables: [],
    compose: `services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - data:/app/data
    x-provelox:
      expose: true
      port: 3001
volumes:
  data:
`,
  },
  {
    id: 'wordpress',
    icon: 'wordpress',
    name: 'WordPress',
    description:
      'WordPress with its own MariaDB database. Site files and database are kept on volumes.',
    category: 'Web',
    mainService: 'wordpress',
    port: 80,
    publicWeb: true,
    variables: [
      {
        key: 'DB_NAME',
        label: 'Database name',
        default: 'wordpress',
        kind: 'text',
      },
      {
        key: 'DB_USER',
        label: 'Database user',
        default: 'wordpress',
        kind: 'text',
      },
      secret('DB_PASSWORD', 'Database password'),
      secret('DB_ROOT_PASSWORD', 'Database root password'),
    ],
    compose: `services:
  wordpress:
    image: wordpress:6
    restart: unless-stopped
    depends_on: [db]
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: \${DB_NAME}
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
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
  {
    id: 'adminer',
    icon: 'adminer',
    name: 'Adminer',
    description:
      'A small web page for browsing and editing databases (PostgreSQL, MySQL and more).',
    category: 'Tools',
    mainService: 'adminer',
    port: 8080,
    publicWeb: true,
    variables: [],
    compose: `services:
  adminer:
    image: adminer:latest
    restart: unless-stopped
    x-provelox:
      expose: true
      port: 8080
`,
  },
  ...APP_TEMPLATES,
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** The template without its compose file, for the catalog listing. */
export const summarize = ({ compose: _compose, ...rest }: Template) => rest;
