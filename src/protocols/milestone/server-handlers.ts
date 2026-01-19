import {
  RpcServerContext,
  RpcHandlerRegistry,
  RpcServerRequestHandler,
  RpcError,
} from "teleportal/protocol";
import type { MilestoneStorage, MilestoneTrigger } from "teleportal/storage";
import type { Server } from "../../server/server";
import type { Session } from "../../server/session";
import type { ServerContext } from "teleportal";
import {
  MilestoneListRequest,
  MilestoneGetRequest,
  MilestoneCreateRequest,
  MilestoneUpdateNameRequest,
  MilestoneDeleteRequest,
  MilestoneRestoreRequest,
} from "./methods";

type Timer = ReturnType<typeof setTimeout>;

interface MilestoneTriggerState {
  lastMilestoneTime: number;
  updateCount: number;
  triggerTimers: Map<string, Timer>;
  unsubscribers: (() => void)[];
}

const documentTriggerState = new WeakMap<
  Session<ServerContext>,
  Map<string, MilestoneTriggerState>
>();

async function createAutomaticMilestone(
  session: Session<ServerContext>,
  documentId: string,
  trigger: MilestoneTrigger,
  milestoneStorage: MilestoneStorage,
  state: MilestoneTriggerState,
  onMilestoneCreated?: (milestoneId: string, docId: string) => void,
): Promise<void> {
  try {
    const doc = await session.storage.getDocument(documentId);
    if (!doc) return;

    const snapshot = doc.content
      .update as unknown as import("teleportal").MilestoneSnapshot;

    let name: string;
    if (typeof trigger.autoName === "string") {
      name = trigger.autoName;
    } else {
      const existingMilestones =
        await milestoneStorage.getMilestones(documentId);
      name = `Milestone ${existingMilestones.length + 1}`;
    }

    const createdAt = Date.now();
    const milestoneId = await milestoneStorage.createMilestone({
      name,
      documentId,
      createdAt,
      snapshot,
      createdBy: { type: "system", id: "auto" },
    });

    state.lastMilestoneTime = createdAt;
    state.updateCount = 0;

    await session.storage.transaction(documentId, async () => {
      const metadata = await session.storage.getDocumentMetadata(documentId);
      await session.storage.writeDocumentMetadata(documentId, {
        ...metadata,
        milestones: [...new Set([...(metadata.milestones ?? []), milestoneId])],
        updatedAt: createdAt,
      });
    });

    session.call("milestone-created", {
      documentId: documentId.split(":").pop() ?? documentId,
      namespacedDocumentId: documentId,
      milestoneId,
      milestoneName: name,
      triggerType: trigger.type,
      triggerId: trigger.id,
      context: {} as ServerContext,
    });

    onMilestoneCreated?.(milestoneId, documentId);
  } catch (error) {
    console.error("Failed to create automatic milestone:", error);
  }
}

type ListResponse = {
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
type GetResponse = { milestoneId: string; snapshot: Uint8Array };
type CreateResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
type UpdateNameResponse = {
  milestone: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    createdBy: { type: "user" | "system"; id: string };
  };
};
type DeleteResponse = { milestoneId: string };
type RestoreResponse = {
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

const listMilestoneHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneListRequest,
    context: RpcServerContext,
  ): Promise<{ response: ListResponse | RpcError }> => {
    try {
      const milestones = await milestoneStorage.getMilestones(
        context.documentId,
        {
          includeDeleted: payload.includeDeleted,
        },
      );
      return {
        response: {
          milestones: milestones.map((m) => ({
            id: m.id,
            name: m.name,
            documentId: m.documentId,
            createdAt: m.createdAt,
            deletedAt: m.deletedAt,
            lifecycleState: m.lifecycleState,
            expiresAt: m.expiresAt,
            createdBy: m.createdBy,
          })),
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to list milestones",
        },
      };
    }
  };

const getMilestoneHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneGetRequest,
    context: RpcServerContext,
  ): Promise<{ response: GetResponse | RpcError }> => {
    try {
      const milestone = await milestoneStorage.getMilestone(
        context.documentId,
        payload.milestoneId,
      );
      if (!milestone) {
        return {
          response: {
            type: "error",
            statusCode: 404,
            details: "Milestone not found",
            payload: {
              milestoneId: payload.milestoneId,
            },
          },
        };
      }
      const snapshot = await milestone.fetchSnapshot();
      return {
        response: {
          milestoneId: payload.milestoneId,
          snapshot: snapshot as Uint8Array,
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error ? error.message : "Failed to get milestone",
        },
      };
    }
  };

const createMilestoneHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneCreateRequest,
    context: RpcServerContext,
  ): Promise<{ response: CreateResponse | RpcError }> => {
    try {
      const userId =
        typeof context.userId === "string" ? context.userId : undefined;
      const milestoneId = await milestoneStorage.createMilestone({
        name:
          payload.name ??
          `Version ${((await context.session.storage.getDocumentMetadata(context.documentId)).milestones?.length ?? 0) + 1}`,
        documentId: context.documentId,
        createdAt: Date.now(),
        snapshot: payload.snapshot as any,
        createdBy: userId
          ? { type: "user" as const, id: userId }
          : { type: "system" as const, id: "system" },
      });
      const milestone = await milestoneStorage.getMilestone(
        context.documentId,
        milestoneId,
      );
      if (!milestone) {
        return {
          response: {
            type: "error",
            statusCode: 500,
            details: "Failed to create milestone",
          },
        };
      }

      await context.session.storage.transaction(
        context.documentId,
        async () => {
          const metadata = await context.session.storage.getDocumentMetadata(
            context.documentId,
          );
          await context.session.storage.writeDocumentMetadata(
            context.documentId,
            {
              ...metadata,
              milestones: [
                ...new Set([...(metadata.milestones ?? []), milestoneId]),
              ],
              updatedAt: Date.now(),
            },
          );
        },
      );

      return {
        response: {
          milestone: {
            id: milestone.id,
            name: milestone.name,
            documentId: milestone.documentId,
            createdAt: milestone.createdAt,
            createdBy: milestone.createdBy,
          },
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to create milestone",
        },
      };
    }
  };

const updateNameHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneUpdateNameRequest,
    context: RpcServerContext,
  ): Promise<{ response: UpdateNameResponse | RpcError }> => {
    try {
      await milestoneStorage.updateMilestoneName(
        context.documentId,
        payload.milestoneId,
        payload.name,
      );
      const milestone = await milestoneStorage.getMilestone(
        context.documentId,
        payload.milestoneId,
      );
      if (!milestone) {
        return {
          response: {
            type: "error",
            statusCode: 500,
            details: "Failed to update milestone name",
          },
        };
      }
      return {
        response: {
          milestone: {
            id: milestone.id,
            name: milestone.name,
            documentId: milestone.documentId,
            createdAt: milestone.createdAt,
            createdBy: milestone.createdBy,
          },
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to update milestone name",
        },
      };
    }
  };

const deleteMilestoneHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneDeleteRequest,
    context: RpcServerContext,
  ): Promise<{ response: DeleteResponse | RpcError }> => {
    try {
      const userId =
        typeof context.userId === "string" ? context.userId : undefined;
      await milestoneStorage.deleteMilestone(
        context.documentId,
        payload.milestoneId,
        userId,
      );
      return { response: { milestoneId: payload.milestoneId } };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to delete milestone",
        },
      };
    }
  };

const restoreMilestoneHandler =
  (milestoneStorage: MilestoneStorage) =>
  async (
    payload: MilestoneRestoreRequest,
    context: RpcServerContext,
  ): Promise<{ response: RestoreResponse | RpcError }> => {
    try {
      const userId =
        typeof context.userId === "string" ? context.userId : undefined;
      await milestoneStorage.restoreMilestone(
        context.documentId,
        payload.milestoneId,
      );
      const milestone = await milestoneStorage.getMilestone(
        context.documentId,
        payload.milestoneId,
      );
      if (!milestone) {
        return {
          response: {
            type: "error",
            statusCode: 500,
            details: "Failed to restore milestone",
          },
        };
      }
      return {
        response: {
          milestone: {
            id: milestone.id,
            name: milestone.name,
            documentId: milestone.documentId,
            createdAt: milestone.createdAt,
            deletedAt: milestone.deletedAt,
            lifecycleState: milestone.lifecycleState,
            expiresAt: milestone.expiresAt,
            createdBy: milestone.createdBy,
          },
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to restore milestone",
        },
      };
    }
  };

/**
 * Creates RPC handlers for milestone operations.
 *
 * The handlers automatically set up lifecycle hooks via the `init` method on the list handler,
 * which listens for `session-open` events to configure automatic milestone triggers.
 * Cleanup is handled automatically when the server is disposed.
 *
 * @param milestoneStorage - Storage backend for milestones
 * @param options - Optional configuration for triggers and callbacks
 * @returns RPC handler registry to pass to Server
 */
export function getMilestoneRpcHandlers(
  milestoneStorage: MilestoneStorage,
  options?: {
    triggers?: MilestoneTrigger[];
    onMilestoneCreated?: (milestoneId: string, documentId: string) => void;
  },
): RpcHandlerRegistry {
  const triggers = options?.triggers ?? [];
  const sessionStates = new WeakMap<
    Session<ServerContext>,
    Map<string, MilestoneTriggerState>
  >();
  const trackedSessions = new Set<Session<ServerContext>>();
  const unsubscribers: (() => void)[] = [];

  function setupSessionTriggers(session: Session<ServerContext>): void {
    if (trackedSessions.has(session)) return;
    trackedSessions.add(session);

    // Clean up tracked session when it's disposed to prevent memory leaks
    const disposeUnsub = session.on("dispose", () => {
      trackedSessions.delete(session);
    });
    unsubscribers.push(disposeUnsub);

    let stateMap = sessionStates.get(session);
    if (!stateMap) {
      stateMap = new Map();
      sessionStates.set(session, stateMap);
    }

    // Listen for document-write events
    const writeUnsub = session.on("document-write", (data) => {
      const documentId = data.namespacedDocumentId;
      if (!documentId) return;

      let state = stateMap.get(documentId);
      if (!state) {
        state = {
          lastMilestoneTime: Date.now(),
          updateCount: 0,
          triggerTimers: new Map(),
          unsubscribers: [],
        };
        stateMap.set(documentId, state);

        // Set up time-based and event-based triggers for this document
        for (const trigger of triggers) {
          if (!trigger.enabled) continue;

          if (trigger.type === "time-based") {
            const timer = setInterval(async () => {
              await createAutomaticMilestone(
                session,
                documentId,
                trigger,
                milestoneStorage,
                state!,
                options?.onMilestoneCreated,
              );
            }, trigger.config.interval);
            state!.triggerTimers.set(trigger.id, timer);
          } else if (trigger.type === "event-based") {
            const handler = async (eventData: any) => {
              try {
                if (
                  trigger.config.condition &&
                  !trigger.config.condition(eventData)
                ) {
                  return;
                }
                await createAutomaticMilestone(
                  session,
                  documentId,
                  trigger,
                  milestoneStorage,
                  state!,
                  options?.onMilestoneCreated,
                );
              } catch (error) {
                console.error("Failed to process event-based trigger:", error);
              }
            };
            session.on(trigger.config.event as any, handler);
            state!.unsubscribers.push(() =>
              session.off(trigger.config.event as any, handler),
            );
          }
        }
      }

      state.updateCount++;

      // Handle update-count and time-based triggers on write
      for (const trigger of triggers) {
        if (!trigger.enabled) continue;

        if (trigger.type === "update-count") {
          const config = trigger.config as { updateCount: number };
          if (state.updateCount >= config.updateCount) {
            void createAutomaticMilestone(
              session,
              documentId,
              trigger,
              milestoneStorage,
              state,
              options?.onMilestoneCreated,
            );
          }
        } else if (trigger.type === "time-based") {
          const config = trigger.config as { interval: number };
          if (Date.now() - state.lastMilestoneTime >= config.interval) {
            void createAutomaticMilestone(
              session,
              documentId,
              trigger,
              milestoneStorage,
              state,
              options?.onMilestoneCreated,
            );
          }
        }
      }
    });
    unsubscribers.push(writeUnsub);
  }

  function cleanup(): void {
    // Clear all timers and event handlers for tracked sessions
    for (const session of trackedSessions) {
      const stateMap = sessionStates.get(session);
      if (stateMap) {
        for (const state of stateMap.values()) {
          for (const timer of state.triggerTimers.values()) {
            clearInterval(timer);
          }
          for (const unsub of state.unsubscribers) {
            unsub();
          }
        }
      }
    }
    trackedSessions.clear();
    // Call all unsubscribers (session-open listener, document-write listeners)
    unsubscribers.forEach((fn) => fn());
    unsubscribers.length = 0;
  }

  return {
    ["milestoneList"]: {
      handler: listMilestoneHandler(milestoneStorage),
      init: (server) => {
        const sessionOpenUnsub = server.on(
          "session-open",
          ({ session }: { session: Session<ServerContext> }) => {
            setupSessionTriggers(session);
          },
        );
        unsubscribers.push(sessionOpenUnsub);

        // Return cleanup function - called automatically when server disposes
        return cleanup;
      },
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["milestoneGet"]: {
      handler: getMilestoneHandler(milestoneStorage),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["milestoneCreate"]: {
      handler: createMilestoneHandler(milestoneStorage),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["milestoneUpdateName"]: {
      handler: updateNameHandler(milestoneStorage),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["milestoneDelete"]: {
      handler: deleteMilestoneHandler(milestoneStorage),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["milestoneRestore"]: {
      handler: restoreMilestoneHandler(milestoneStorage),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
  };
}
