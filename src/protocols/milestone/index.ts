export { getMilestoneRpcHandlers } from "./server-handlers";
export { createMilestoneRpc } from "./client";
export type { MilestoneRpc } from "./client";

export type {
  MilestoneListRequest,
  MilestoneListResponse,
  MilestoneGetRequest,
  MilestoneGetResponse,
  MilestoneCreateRequest,
  MilestoneCreateResponse,
  MilestoneUpdateNameRequest,
  MilestoneUpdateNameResponse,
  MilestoneDeleteRequest,
  MilestoneDeleteResponse,
  MilestoneRestoreRequest,
  MilestoneRestoreResponse,
} from "./methods";
