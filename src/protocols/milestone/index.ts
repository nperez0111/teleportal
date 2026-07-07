export { getMilestoneRpcHandlers } from "./server";
export { createMilestoneRpc } from "./client";
export type { MilestoneRpc } from "./client";

export {
  milestoneProtocol,
  milestoneList,
  milestoneGet,
  milestoneCreate,
  milestoneUpdateName,
  milestoneDelete,
  milestoneRestore,
} from "./methods";

export type {
  MilestoneMeta,
  MilestoneMetaFull,
  MilestoneCreatedBy,
  MilestoneGetRequest,
  MilestoneGetResponse,
} from "./methods";
