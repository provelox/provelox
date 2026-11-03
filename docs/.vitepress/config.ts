import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Provelox',
  description: 'Deploy faster. Scale smarter. Documentation for Provelox.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/icon.svg' }]],
  themeConfig: {
    logo: '/icon.svg',
    siteTitle: 'Provelox',
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Migration', link: '/migration/overview' },
      { text: 'Reference', link: '/reference/cli' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Install', link: '/guide/install' },
          { text: 'Servers and clusters', link: '/guide/cluster' },
          { text: 'Domains and HTTPS', link: '/guide/domains-and-https' },
          { text: 'Behind a CDN', link: '/guide/behind-a-cdn' },
          { text: 'Sign in with…', link: '/guide/sign-in-with' },
          { text: 'Template registries', link: '/guide/template-registries' },
          { text: 'Group running apps', link: '/guide/grouping-apps' },
          { text: 'Downloading data', link: '/guide/downloading-data' },
          { text: 'Restoring data', link: '/guide/restoring-data' },
          { text: 'Database backup', link: '/guide/database-backup' },
          {
            text: 'Moving to a new server',
            link: '/guide/moving-to-a-new-server',
          },
          { text: 'Removing Provelox', link: '/guide/removing-provelox' },
          { text: 'Security', link: '/guide/security' },
          { text: 'Security checks', link: '/guide/security-checks' },
        ],
      },
      {
        text: 'Migration',
        items: [
          { text: 'Overview', link: '/migration/overview' },
          { text: 'From CapRover', link: '/migration/caprover' },
          { text: 'Adding a source', link: '/migration/adding-a-source' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Command line', link: '/reference/cli' },
          { text: 'Compose file', link: '/reference/compose-file' },
        ],
      },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    footer: { message: 'Documentation in progress.' },
  },
});
