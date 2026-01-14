import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Teleportal",
  description: "Build your own Y.js sync server: any storage, any JS runtime, any transport",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/server' },
      { text: 'Examples', link: '/examples' }
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Quick Start', link: '/guide/quick-start' }
        ]
      },
      {
        text: 'Server',
        items: [
          { text: 'Server Setup', link: '/guide/server-setup' },
          { text: 'WebSocket Server', link: '/guide/websocket-server' },
          { text: 'HTTP Server', link: '/guide/http-server' },
          { text: 'Storage Configuration', link: '/guide/storage' },
          { text: 'Authentication', link: '/guide/authentication' },
          { text: 'Monitoring', link: '/guide/monitoring' }
        ]
      },
      {
        text: 'Client',
        items: [
          { text: 'Provider Setup', link: '/guide/provider-setup' },
          { text: 'Connections', link: '/guide/connections' },
          { text: 'Offline Persistence', link: '/guide/offline-persistence' },
          { text: 'Subdocuments', link: '/guide/subdocuments' },
          { text: 'Milestones', link: '/guide/milestones' }
        ]
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Protocol', link: '/guide/protocol' },
          { text: 'Encryption', link: '/guide/encryption' },
          { text: 'File Transfer', link: '/guide/file-transfer' },
          { text: 'Transport Middleware', link: '/guide/transports' },
          { text: 'Custom Storage', link: '/guide/custom-storage' }
        ]
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Server API', link: '/api/server' },
          { text: 'Provider API', link: '/api/provider' },
          { text: 'Storage API', link: '/api/storage' },
          { text: 'Token API', link: '/api/token' }
        ]
      },
      {
        text: 'Examples',
        items: [
          { text: 'Basic Example', link: '/examples/basic' },
          { text: 'With Authentication', link: '/examples/authentication' },
          { text: 'With Encryption', link: '/examples/encryption' },
          { text: 'File Upload', link: '/examples/file-upload' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/nperez0111/teleportal' }
    ],

    search: {
      provider: 'local'
    }
  }
})
