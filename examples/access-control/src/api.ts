const baseUrl = new URL("./", window.location.href).href;

function apiUrl(path: string): string {
  return new URL(path, baseUrl).href;
}

export type SetupUser = {
  token: string;
  wrappingKey: string;
  role: string;
  displayName: string;
};

export type SetupResponse = {
  documentId: string;
  room: string;
  users: Record<string, SetupUser>;
};

export type RevokeResponse = {
  success: boolean;
  generation: number;
};

export type RotateResponse = {
  success: boolean;
  generation: number;
};

export type RestoreResponse = {
  token: string;
  wrappingKey: string;
  role: string;
};

export type MetaResponse = {
  generation: number;
  userIds: string[];
};

export async function setup(): Promise<SetupResponse> {
  const res = await fetch(apiUrl("api/setup"), { method: "POST" });
  return res.json();
}

export async function revokeUser(userId: string): Promise<RevokeResponse> {
  const res = await fetch(apiUrl("api/revoke"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  return res.json();
}

export async function rotateKeys(excludeUserIds: string[]): Promise<RotateResponse> {
  const res = await fetch(apiUrl("api/rotate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excludeUserIds }),
  });
  return res.json();
}

export async function fetchMeta(): Promise<MetaResponse> {
  const res = await fetch(apiUrl("api/meta"));
  return res.json();
}

export async function restoreUser(userId: string, role: string): Promise<RestoreResponse> {
  const res = await fetch(apiUrl("api/restore"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  return res.json();
}
