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
  { snapshotIds?: string[]; includeDeleted?: boolean },
  { milestones: MilestoneMetaFull[] }
>();

export const milestoneGet = defineMethod<
  { milestoneId: string },
  { milestoneId: string; snapshot: Uint8Array }
>();

export const milestoneCreate = defineMethod<
  { name?: string; snapshot: Uint8Array },
  { milestone: MilestoneMeta }
>();

export const milestoneUpdateName = defineMethod<
  { milestoneId: string; name: string },
  { milestone: MilestoneMeta }
>();

export const milestoneDelete = defineMethod<{ milestoneId: string }, { milestoneId: string }>();

export const milestoneRestore = defineMethod<
  { milestoneId: string },
  { milestone: MilestoneMetaFull }
>();

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
// Legacy request/response types (used by attribution protocol)
// ---------------------------------------------------------------------------

export type MilestoneGetRequest = {
  milestoneId: string;
};

export type MilestoneGetResponse = {
  milestoneId: string;
  snapshot: Uint8Array;
};
