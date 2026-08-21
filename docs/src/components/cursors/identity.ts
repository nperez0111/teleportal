const ADJECTIVES = [
  "Swift",
  "Calm",
  "Bold",
  "Bright",
  "Keen",
  "Brave",
  "Sly",
  "Wise",
  "Warm",
  "Cool",
  "Quick",
  "Lazy",
  "Tiny",
  "Grand",
  "Witty",
  "Chill",
  "Lucky",
  "Spry",
  "Neat",
  "Vivid",
];

const ANIMALS = [
  "Penguin",
  "Otter",
  "Fox",
  "Owl",
  "Panda",
  "Raven",
  "Wolf",
  "Bear",
  "Hawk",
  "Lynx",
  "Crane",
  "Hare",
  "Seal",
  "Deer",
  "Finch",
  "Koala",
  "Parrot",
  "Gecko",
  "Badger",
  "Moose",
];

const COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ee6352",
  "#9ac2c9",
  "#e056a0",
  "#8acb88",
  "#1be7ff",
  "#f7b32b",
  "#a06cd5",
];

const STORAGE_KEY = "teleportal-docs-identity";

export interface Identity {
  name: string;
  color: string;
}

export function getOrCreateIdentity(): Identity {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.name && parsed.color) return parsed;
    }
  } catch {}

  const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const identity: Identity = { name, color };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {}

  return identity;
}
