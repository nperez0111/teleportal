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
