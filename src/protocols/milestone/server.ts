import { createHandlers, ok, err, type RpcHandlerRegistry } from "teleportal/rpc";
import type { MilestoneStorage, MilestoneTrigger } from "teleportal/storage";
import { emitWideEvent } from "../../server/logger";
import type { Session } from "../../server/session";
import type { ServerContext } from "teleportal";
import { milestoneProtocol } from "./methods";

interface MilestoneTriggerState {
  lastMilestoneTime: number;
  updateCount: number;
  /** Unsubscribe callbacks for event-based trigger listeners. */
  unsubscribers: (() => void)[];
}

async function createAutomaticMilestone(
  session: Session<ServerContext>,
  documentId: string,
  trigger: MilestoneTrigger,
  milestoneStorage: MilestoneStorage,
  onMilestoneCreated?: (milestoneId: string, docId: string) => void,
): Promise<void> {
  try {
    const doc = await session.storage.getDocument(documentId);
    if (!doc) return;

    const snapshot = doc.content.update as unknown as import("teleportal").MilestoneSnapshot;

    let name: string;
    if (typeof trigger.autoName === "string") {
      name = trigger.autoName;
    } else {
      const existingMilestones = await milestoneStorage.getMilestones(documentId);
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

    // Trigger accounting (updateCount / lastMilestoneTime) is reset
    // synchronously at the decision point on the document-write path, so this
    // fire-and-forget helper deliberately does not touch it — doing so here
    // would race with, and discard, writes that arrived while it was in flight.

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
    emitWideEvent("error", {
      event_type: "milestone_auto_create_failed",
      timestamp: new Date().toISOString(),
      document_id: documentId,
      trigger_type: trigger.type,
      trigger_id: trigger.id,
      error,
    });
  }
}

interface MilestoneDeps {
  milestoneStorage: MilestoneStorage;
  triggers: MilestoneTrigger[];
  onMilestoneCreated?: (milestoneId: string, documentId: string) => void;
}

/**
 * Creates RPC handlers for milestone operations.
 *
 * The handlers automatically set up lifecycle hooks via the `init` callback,
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
  const deps: MilestoneDeps = {
    milestoneStorage,
    triggers: options?.triggers ?? [],
    onMilestoneCreated: options?.onMilestoneCreated,
  };

  return createHandlers(
    milestoneProtocol,
    deps,
    {
      list:
        ({ milestoneStorage }) =>
        async (payload, context) => {
          const milestones = await milestoneStorage.getMilestones(context.documentId, {
            includeDeleted: payload.includeDeleted,
          });
          return ok({
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
          });
        },

      get:
        ({ milestoneStorage }) =>
        async (payload, context) => {
          const milestone = await milestoneStorage.getMilestone(
            context.documentId,
            payload.milestoneId,
          );
          if (!milestone) {
            return err(404, "Milestone not found", { milestoneId: payload.milestoneId });
          }
          const snapshot = await milestone.fetchSnapshot();
          return ok(
            { milestoneId: payload.milestoneId, snapshot: snapshot as Uint8Array },
            { encrypted: context.session.encrypted },
          );
        },

      create:
        ({ milestoneStorage }) =>
        async (payload, context) => {
          const userId = typeof context.userId === "string" ? context.userId : undefined;
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
          const milestone = await milestoneStorage.getMilestone(context.documentId, milestoneId);
          if (!milestone) {
            return err(500, "Failed to create milestone");
          }

          await context.session.storage.transaction(context.documentId, async () => {
            const metadata = await context.session.storage.getDocumentMetadata(context.documentId);
            await context.session.storage.writeDocumentMetadata(context.documentId, {
              ...metadata,
              milestones: [...new Set([...(metadata.milestones ?? []), milestoneId])],
              updatedAt: Date.now(),
            });
          });

          return ok({
            milestone: {
              id: milestone.id,
              name: milestone.name,
              documentId: milestone.documentId,
              createdAt: milestone.createdAt,
              createdBy: milestone.createdBy,
            },
          });
        },

      updateName:
        ({ milestoneStorage }) =>
        async (payload, context) => {
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
            return err(500, "Failed to update milestone name");
          }
          return ok({
            milestone: {
              id: milestone.id,
              name: milestone.name,
              documentId: milestone.documentId,
              createdAt: milestone.createdAt,
              createdBy: milestone.createdBy,
            },
          });
        },

      delete:
        ({ milestoneStorage }) =>
        async (payload, context) => {
          const userId = typeof context.userId === "string" ? context.userId : undefined;
          await milestoneStorage.deleteMilestone(context.documentId, payload.milestoneId, userId);
          return ok({ milestoneId: payload.milestoneId });
        },

      restore:
        ({ milestoneStorage }) =>
        async (payload, context) => {
          await milestoneStorage.restoreMilestone(context.documentId, payload.milestoneId);
          const milestone = await milestoneStorage.getMilestone(
            context.documentId,
            payload.milestoneId,
          );
          if (!milestone) {
            return err(500, "Failed to restore milestone");
          }
          return ok({
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
          });
        },
    },
    {
      init: (server, { milestoneStorage, triggers, onMilestoneCreated }) => {
        const sessionStates = new WeakMap<
          Session<ServerContext>,
          Map<string, MilestoneTriggerState>
        >();
        const trackedSessions = new Set<Session<ServerContext>>();
        const unsubscribers: (() => void)[] = [];

        function setupSessionTriggers(session: Session<ServerContext>): void {
          if (trackedSessions.has(session)) return;
          trackedSessions.add(session);

          const disposeUnsub = session.on("dispose", () => {
            trackedSessions.delete(session);
          });
          unsubscribers.push(disposeUnsub);

          let stateMap = sessionStates.get(session);
          if (!stateMap) {
            stateMap = new Map();
            sessionStates.set(session, stateMap);
          }

          const writeUnsub = session.on("document-write", (data) => {
            const documentId = data.namespacedDocumentId;
            if (!documentId) return;

            let state = stateMap.get(documentId);
            if (!state) {
              state = {
                lastMilestoneTime: Date.now(),
                updateCount: 0,
                unsubscribers: [],
              };
              stateMap.set(documentId, state);

              for (const trigger of triggers) {
                if (!trigger.enabled) continue;

                // Time-based and update-count triggers are evaluated on the
                // document-write path below. Only event-based triggers need a
                // subscription set up here. (A time-based trigger must NOT get a
                // self-firing setInterval: it would double-count against the
                // write-path check and keep creating milestones while the
                // document is idle.)
                if (trigger.type === "event-based") {
                  const handler = async (eventData: any) => {
                    try {
                      if (trigger.config.condition && !trigger.config.condition(eventData)) {
                        return;
                      }
                      await createAutomaticMilestone(
                        session,
                        documentId,
                        trigger,
                        milestoneStorage,
                        onMilestoneCreated,
                      );
                    } catch (error) {
                      emitWideEvent("error", {
                        event_type: "milestone_event_trigger_failed",
                        timestamp: new Date().toISOString(),
                        document_id: documentId,
                        trigger_type: trigger.type,
                        trigger_id: trigger.id,
                        error,
                      });
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

            for (const trigger of triggers) {
              if (!trigger.enabled) continue;

              if (trigger.type === "update-count") {
                const config = trigger.config as { updateCount: number };
                if (state.updateCount >= config.updateCount) {
                  // Reset the accounting synchronously, BEFORE the async
                  // creation. createAutomaticMilestone is fire-and-forget, so
                  // without this every subsequent write while it is in flight
                  // would still see updateCount >= threshold and spawn a
                  // duplicate milestone.
                  state.updateCount = 0;
                  state.lastMilestoneTime = Date.now();
                  void createAutomaticMilestone(
                    session,
                    documentId,
                    trigger,
                    milestoneStorage,
                    onMilestoneCreated,
                  );
                }
              } else if (trigger.type === "time-based") {
                const config = trigger.config as { interval: number };
                if (Date.now() - state.lastMilestoneTime >= config.interval) {
                  // See note above: reset synchronously so concurrent writes
                  // don't each re-fire before the async create resets the clock.
                  state.lastMilestoneTime = Date.now();
                  state.updateCount = 0;
                  void createAutomaticMilestone(
                    session,
                    documentId,
                    trigger,
                    milestoneStorage,
                    onMilestoneCreated,
                  );
                }
              }
            }
          });
          unsubscribers.push(writeUnsub);
        }

        const sessionOpenUnsub = server.on(
          "session-open",
          ({ session }: { session: Session<ServerContext> }) => {
            setupSessionTriggers(session);
          },
        );
        unsubscribers.push(sessionOpenUnsub);

        return () => {
          for (const session of trackedSessions) {
            const stateMap = sessionStates.get(session);
            if (stateMap) {
              for (const state of stateMap.values()) {
                for (const unsub of state.unsubscribers) {
                  unsub();
                }
              }
            }
          }
          trackedSessions.clear();
          unsubscribers.forEach((fn) => fn());
          unsubscribers.length = 0;
        };
      },
    },
  );
}
