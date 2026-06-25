import { defineMethod, defineProtocol } from "teleportal/rpc";

// ---------------------------------------------------------------------------
// Shared shapes (used in multiple methods)
// ---------------------------------------------------------------------------

export type MilestoneCreatedBy = { type: "user" | "system"; id: string };

export type MilestoneMeta = {
  id: string;
  name: string;
  documentId: string;
  createdAt: number;
  createdBy: MilestoneCreatedBy;
};

export type MilestoneMetaFull = MilestoneMeta & {
  deletedAt?: number;
  lifecycleState?: "active" | "deleted" | "archived" | "expired";
  expiresAt?: number;
};

// ---------------------------------------------------------------------------
// Method contracts
// ---------------------------------------------------------------------------

export const milestoneList = defineMethod<
  "milestoneList",
  { snapshotIds?: string[]; includeDeleted?: boolean },
  { milestones: MilestoneMetaFull[] }
>("milestoneList");

export const milestoneGet = defineMethod<
  "milestoneGet",
  { milestoneId: string },
  { milestoneId: string; snapshot: Uint8Array }
>("milestoneGet");

export const milestoneCreate = defineMethod<
  "milestoneCreate",
  { name?: string; snapshot: Uint8Array },
  { milestone: MilestoneMeta }
>("milestoneCreate");

export const milestoneUpdateName = defineMethod<
  "milestoneUpdateName",
  { milestoneId: string; name: string },
  { milestone: MilestoneMeta }
>("milestoneUpdateName");

export const milestoneDelete = defineMethod<
  "milestoneDelete",
  { milestoneId: string },
  { milestoneId: string }
>("milestoneDelete");

export const milestoneRestore = defineMethod<
  "milestoneRestore",
  { milestoneId: string },
  { milestone: MilestoneMetaFull }
>("milestoneRestore");

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export const milestoneProtocol = defineProtocol("milestone", {
  list: milestoneList,
  get: milestoneGet,
  create: milestoneCreate,
  updateName: milestoneUpdateName,
  delete: milestoneDelete,
  restore: milestoneRestore,
});

// ---------------------------------------------------------------------------
// Legacy request/response types
// ---------------------------------------------------------------------------

export type MilestoneListRequest = {
  snapshotIds?: string[];
  includeDeleted?: boolean;
};

export type MilestoneListResponse = {
  milestones: Array<{
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    lifecycleState?: "active" | "deleted" | "archived" | "expired";
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  }>;
};

export type MilestoneGetRequest = {
  milestoneId: string;
};

export type MilestoneGetResponse = {
  milestoneId: string;
  snapshot: Uint8Array;
};

export type MilestoneCreateRequest = {
  name?: string;
  snapshot: Uint8Array;
};

export type MilestoneCreateResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};

export type MilestoneUpdateNameRequest = {
  milestoneId: string;
  name: string;
};

export type MilestoneUpdateNameResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};

export type MilestoneDeleteRequest = {
  milestoneId: string;
};

export type MilestoneDeleteResponse = {
  milestoneId: string;
};

export type MilestoneRestoreRequest = {
  milestoneId: string;
};

export type MilestoneRestoreResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    lifecycleState?: "active" | "deleted" | "archived" | "expired";
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
