/**
 * Stable user identity for the playground.
 *
 * Stored in localStorage so the identity persists across tabs and sessions,
 * matching how a real app with authentication works. This ensures the
 * encryption key registry always finds the user's wrapped key on reconnect.
 */

const KEY = "teleportal-identity";

const ADJECTIVES = ["Swift", "Curious", "Bold", "Calm", "Bright", "Keen", "Quiet", "Lucky"];
const ANIMALS = ["Otter", "Falcon", "Fox", "Heron", "Lynx", "Wren", "Bear", "Moth"];

function randomName(): string {
  // Avoid Math.random bias concerns — this is purely cosmetic demo identity.
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

/**
 * A stable, vivid color for any user id, so every client renders the same
 * author in the same color across the timeline, cursors, and composition bar.
 */
export function colorForUser(userId: string): string {
  let hue = 0;
  for (let i = 0; i < userId.length; i++) {
    hue = (hue * 31 + userId.charCodeAt(i)) % 360;
  }
  return hslToHex(hue, 70, 50);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface Identity {
  name: string;
  color: string;
}

export function getIdentity(): Identity {
  let name = localStorage.getItem(KEY);
  if (!name) {
    name = randomName();
    localStorage.setItem(KEY, name);
  }
  return { name, color: colorForUser(name) };
}

/**
 * Update this tab's identity. The active connection is tied to the identity's
 * token, so the caller is expected to reload to reconnect as the new user.
 */
export function setIdentity(name: string): Identity {
  const trimmed = name.trim() || randomName();
  localStorage.setItem(KEY, trimmed);
  return { name: trimmed, color: colorForUser(trimmed) };
}
