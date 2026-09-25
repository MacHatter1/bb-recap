import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../src/server.ts";

test("does not submit a transcript if its thread is hidden during model lookup", async () => {
  let visibility: "visible" | "hidden" = "visible";
  let notifyThreadChanged: (() => void) | undefined;
  let startModelLookup!: () => void;
  let finishModelLookup!: () => void;
  const modelLookupStarted = new Promise<void>((resolve) => {
    startModelLookup = resolve;
  });
  const modelLookupGate = new Promise<void>((resolve) => {
    finishModelLookup = resolve;
  });
  const db = new Database(":memory:");
  const disposers: Array<() => void | Promise<void>> = [];
  const spawned: unknown[] = [];
  let handlers: any;
  const thread = (threadId: string) => ({
    id: threadId,
    projectId: "test-project",
    environmentId: null,
    providerId: "test-provider",
    status: "idle",
    visibility,
    originPluginId: null,
  });
  const bb = {
    pluginId: "bb-recap",
    storage: {
      database: () => db,
      migrate: (_database: Database.Database, statements: string[]) => {
        for (const statement of statements) db.exec(statement);
      },
      kv: {
        get: async () => undefined,
        set: async () => undefined,
      },
    },
    sdk: {
      subscribe: ({ callback }: any) => {
        notifyThreadChanged = () =>
          callback({
            entity: "thread",
            type: "changed",
            id: "source-thread",
            changes: ["title-changed"],
          });
        return () => {
          notifyThreadChanged = undefined;
        };
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => thread(threadId),
        timeline: async () => ({
          rows: [
            {
              kind: "conversation",
              role: "user",
              threadId: "source-thread",
              text: "Private discussion",
            },
          ],
          timelinePage: { hasOlderRows: false, olderCursor: null },
        }),
        spawn: async () => {
          spawned.push(true);
          return { id: "recap-worker" };
        },
        wait: async () => ({}),
        output: async () => ({ output: "We discussed a private topic." }),
        archive: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
      system: {
        executionOptions: async () => ({
          models: [
            {
              isDefault: true,
              routeProviderId: "test-provider",
              model: "test-model",
              defaultReasoningEffort: "low",
            },
          ],
          providers: [{ id: "test-provider", available: true }],
        }),
      },
      providers: {
        models: async () => {
          startModelLookup();
          await modelLookupGate;
          return {
            models: [
              {
                id: "test-model",
                model: "test-model",
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: "low" }],
                defaultReasoningEffort: "low",
              },
            ],
            providers: [{ id: "test-provider", serviceTiers: [] }],
          };
        },
      },
    },
    rpc: {
      register: (_contract: unknown, registeredHandlers: unknown) => {
        handlers = registeredHandlers;
      },
    },
    cli: { register: () => undefined },
    events: { on: () => undefined },
    realtime: { publish: () => undefined },
    log: { info: () => undefined, warn: () => undefined },
    onDispose: (dispose: () => void | Promise<void>) => {
      disposers.push(dispose);
    },
  } as unknown as BbPluginApi;

  await plugin(bb);
  try {
    const generation = handlers.recap_generate({
      threadId: "source-thread",
      automatic: false,
    });
    await modelLookupStarted;
    visibility = "hidden";
    notifyThreadChanged?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishModelLookup();

    const result = await generation;
    assert.ok(["hidden_thread", "aborted"].includes(result.reason));
    assert.equal(result.generated, false);
    assert.equal(spawned.length, 0);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    db.close();
  }
});
