// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from '@astrojs/react';
import starlightLlmsTxt from 'starlight-llms-txt'
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
  site: 'https://teleportal.tools/',
  integrations: [
    react(),
    mermaid(),
    starlight({
      title: "Teleportal",
      plugins: [starlightLlmsTxt()],
      logo: {
        light: './src/assets/logo_light.svg',
				dark: './src/assets/logo_dark.svg',
        alt: 'Teleportal',
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/nperez0111/teleportal",
        },
        {
          icon: 'blueSky',
          label: 'BlueSky',
          href: 'https://bsky.app/profile/teleportal.tools',
        }
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Getting Started", slug: "getting-started" },
            { label: "Integration Guide", slug: "integration" },
            { label: "What is Teleportal?", slug: "what-is-teleportal" },
          ],
        },
        {
          label: "Core Concepts",
          items: [
            { label: "Protocol", slug: "core-concepts/protocol" },
            { label: "Server", slug: "core-concepts/server" },
            { label: "Transport", slug: "core-concepts/transport" },
            { label: "Provider", slug: "core-concepts/provider" },
            { label: "Milestones", slug: "core-concepts/milestones" },
            { label: "Authentication", slug: "core-concepts/authentication" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "WebSocket Only", slug: "guides/websocket-only" },
            { label: "HTTP Transport", slug: "guides/http-transport" },
            { label: "Fallback Connection", slug: "guides/fallback-connection" },
            { label: "Authentication", slug: "guides/authentication" },
            { label: "Persistent Storage", slug: "guides/persistent-storage" },
            { label: "Encryption at Rest", slug: "guides/encryption-at-rest" },
            { label: "Pub/Sub", slug: "guides/pub-sub" },
            { label: "Observability", slug: "guides/observability" },
            { label: "Custom Storage", slug: "guides/custom-storage" },
            { label: "Rate Limiting", slug: "guides/rate-limiting" },
          ],
        },
        {
          label: "Advanced",
          items: [
            { label: "DevTools", slug: "advanced/devtools" },
            { label: "Custom Storage", slug: "advanced/custom-storage" },
            { label: "Custom Transport", slug: "advanced/custom-transport" },
            { label: "Performance", slug: "advanced/performance" },
            { label: "Scaling", slug: "advanced/scaling" },
            { label: "Protocol Specification", slug: "advanced/protocol" },
          ],
        },
      ],
      customCss: [
				// Relative path to your custom CSS file
				"./src/styles/index.css",
			],
    }),
  ],
});
