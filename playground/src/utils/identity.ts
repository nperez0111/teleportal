/**
 * Per-tab user identity for the attribution demo.
 *
 * Stored in sessionStorage (not localStorage) so that two tabs in the same
 * browser can act as two different authors — open a second tab, change the
 * name, and edits from each tab are attributed to a distinct user.
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
  return `hsl(${hue}, 70%, 50%)`;
}

export interface Identity {
  name: string;
  color: string;
}

export function getIdentity(): Identity {
  let name = sessionStorage.getItem(KEY);
  if (!name) {
    name = randomName();
    sessionStorage.setItem(KEY, name);
  }
  return { name, color: colorForUser(name) };
}

/**
 * Update this tab's identity. The active connection is tied to the identity's
 * token, so the caller is expected to reload to reconnect as the new user.
 */
export function setIdentity(name: string): Identity {
  const trimmed = name.trim() || randomName();
  sessionStorage.setItem(KEY, trimmed);
  return { name: trimmed, color: colorForUser(trimmed) };
}
