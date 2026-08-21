import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

type AppInfo = {
  slug: string;
  title: string;
  description: string;
  tags?: string[];
};

function AppCard({ app }: { app: AppInfo }) {
  return (
    <a
      href={`/${app.slug}/`}
      className="block rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-all hover:shadow-md hover:border-gray-300 hover:-translate-y-0.5"
    >
      <h2 className="text-lg font-semibold text-gray-900 mb-2">{app.title}</h2>
      <p className="text-sm text-gray-600 mb-4">{app.description}</p>
      {app.tags && app.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {app.tags.map((tag) => (
            <span
              key={tag}
              className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </a>
  );
}

function App() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/apps")
      .then((r) => r.json())
      .then(setApps)
      .catch(console.error);
  }, []);

  const filtered = query
    ? apps.filter(
        (a) =>
          a.title.toLowerCase().includes(query.toLowerCase()) ||
          a.description.toLowerCase().includes(query.toLowerCase()) ||
          a.tags?.some((t) => t.toLowerCase().includes(query.toLowerCase())),
      )
    : apps;

  return (
    <div className="min-h-screen px-6 py-12 max-w-4xl mx-auto">
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Teleportal Examples</h1>
        <p className="text-gray-600">
          Collaborative applications powered by Teleportal's Y.js sync server
        </p>
      </div>
      <div className="mb-8">
        <input
          type="text"
          placeholder="Search examples..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((app) => (
          <AppCard key={app.slug} app={app} />
        ))}
      </div>
      {filtered.length === 0 && apps.length > 0 && (
        <p className="text-center text-gray-400 mt-8">No matching examples</p>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
