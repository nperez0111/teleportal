// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Teleportal",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/nperez0111/teleportal",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Concepts", slug: "getting-started/concepts" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Server Setup", slug: "guides/server-setup" },
            { label: "Client Setup", slug: "guides/client-setup" },
            { label: "Storage Backends", slug: "guides/storage-backends" },
            { label: "Authentication", slug: "guides/authentication" },
            { label: "Encryption", slug: "guides/encryption" },
            { label: "File Transfers", slug: "guides/file-transfers" },
            { label: "Milestones", slug: "guides/milestones" },
            { label: "Transports", slug: "guides/transports" },
            { label: "Monitoring", slug: "guides/monitoring" },
            { label: "Deployment", slug: "guides/deployment" },
          ],
        },
        {
          label: "API Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Examples",
          autogenerate: { directory: "examples" },
        },
        {
          label: "Advanced",
          autogenerate: { directory: "advanced" },
        },
      ],
    }),
  ],
});
