import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../src/server.ts";
import type { Recap, RecapSettings } from "../src/server.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createHarness(options: {
  timeline?: (args: { threadId: string; beforeAnchorSeq?: string }) => Promise<unknown>;
  wait?: (threadId: string) => Promise<void>;
  database?: Database.Database;
} = {}) {
  const db = options.database ?? new Database(":memory:");
  const settings = { auto: true, autoCleanup: true, afterSeconds: 86_400, minTurns: 1, maxConcurrent: 1, displayMode: "Compact banner", prompt: "Return a recap." } as RecapSettings;
  const events = new Map<string, (payload: unknown) => void>();
  const spawned: Array<{ prompt: string; reasoningLevel: string; serviceTier?: string }> = [];
  let dispose!: () => Promise<void>;
  let handlers!: {
    recap_generate: (input: { threadId: string; automatic: boolean }) => Promise<{ recap: Recap | null; reason: string | null }>;
    recap_get: (input: { threadId: string }) => Promise<{ generating: boolean }>;
    recap_settings_set: (input: RecapSettings) => Promise<RecapSettings>;
  };
  const thread = (id: string) => ({ id, projectId: "p", environmentId: null, providerId: "p", status: "idle", visibility: "visible", originPluginId: null });
  const bb = {
    pluginId: "bb-recap",
    storage: {
      database: () => db,
      migrate: (_: unknown, statements: string[]) => statements.forEach((statement) => db.exec(statement)),
      kv: { get: async (key: string) => key === "settings" ? settings : { providerId: "p", model: "m", reasoningLevel: "low" }, set: async () => {} },
    },
    sdk: {
      subscribe: () => () => {},
      threads: {
        get: async ({ threadId }: { threadId: string }) => thread(threadId),
        timeline: options.timeline ?? (async ({ threadId }: { threadId: string }) => ({
          rows: [{ id: `${threadId}-user`, kind: "conversation", role: "user", threadId, text: "Work" }],
          timelinePage: { hasOlderRows: false, olderCursor: null },
        })),
        spawn: async (input: (typeof spawned)[number]) => { spawned.push(input); return { id: String(spawned.length) }; },
        wait: async ({ threadId }: { threadId: string }) => { await options.wait?.(threadId); return {}; },
        output: async () => ({ output: "We did work." }), archive: async () => {}, stop: async () => {},
      },
      providers: { models: async () => ({ models: [{ id: "m", model: "m", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }], providers: [{ id: "p" }] }) },
    },
    rpc: { register: (_: unknown, registered: typeof handlers) => { handlers = registered; } },
    cli: { register: () => {} }, events: { on: (name: string, callback: (payload: unknown) => void) => { events.set(name, callback); } },
    realtime: { publish: () => {} }, log: { info: () => {}, warn: () => {} }, onDispose: (callback: typeof dispose) => { dispose = callback; },
  } as unknown as BbPluginApi;
  await plugin(bb);
  return { db, settings, handlers, spawned, activate: (id: string) => events.get("thread.active")?.({ thread: { ...thread(id), status: "running" } }), close: async () => { await dispose(); db.close(); } };
}

test("disabling automatic recaps prevents queued requests from spawning", async () => {
  const started = deferred();
  const release = deferred();
  const harness = await createHarness({ wait: async (id) => { if (id === "1") { started.resolve(); await release.promise; } } });
  try {
    const first = harness.handlers.recap_generate({ threadId: "A", automatic: true });
    await started.promise;
    const queued = harness.handlers.recap_generate({ threadId: "B", automatic: true });
    assert.equal((await harness.handlers.recap_get({ threadId: "B" })).generating, true);
    await harness.handlers.recap_settings_set({ ...harness.settings, auto: false });
    release.resolve();
    await first;
    const stopped = await queued;
    assert.equal(harness.spawned.length, 1);
    assert.equal(stopped.reason, "automatic_disabled");
    const manual = await harness.handlers.recap_generate({ threadId: "B", automatic: false });
    assert.ok(manual.recap);
    assert.equal(harness.spawned.length, 2);
  } finally {
    release.resolve();
    await harness.close();
  }
});

test("pagination cannot skip new requests when older pages drop out of the window", async () => {
  let pageCount = 21;
  const harness = await createHarness({ timeline: async ({ beforeAnchorSeq }) => {
    const page = beforeAnchorSeq === undefined ? pageCount : Number(beforeAnchorSeq) - 1;
    return {
      rows: Array.from({ length: 50 }, (_, index) => ({ id: `page-${page}-${index}`, kind: "conversation", threadId: "source", role: index === 0 && page !== 2 ? "user" : "assistant", text: index === 0 && page !== 2 ? `New request ${page}` : `Activity ${page}.${index}` })),
      timelinePage: { hasOlderRows: page > 1, olderCursor: page > 1 ? { anchorId: `page-${page}`, anchorSeq: page } : null },
    };
  } });
  try {
    await harness.handlers.recap_settings_set({ ...harness.settings, auto: false });
    await harness.handlers.recap_generate({ threadId: "source", automatic: false });
    pageCount = 23;
    harness.activate("source");
    await harness.handlers.recap_generate({ threadId: "source", automatic: false });
    assert.match(harness.spawned[1].prompt, /<previous-recap>/);
    assert.match(harness.spawned[1].prompt, /New request 22/);
    assert.match(harness.spawned[1].prompt, /New request 23/);
    assert.doesNotMatch(harness.spawned[1].prompt, /New request 21/);
    // Counts can stay the same in successive windows; the row ID still moves.
    await harness.handlers.recap_settings_set({ ...harness.settings, auto: true });
    pageCount = 25;
    harness.activate("source");
    await harness.handlers.recap_generate({ threadId: "source", automatic: true });
    assert.equal(harness.spawned.length, 3);
    assert.match(harness.spawned[2].prompt, /New request 24/);
    assert.match(harness.spawned[2].prompt, /New request 25/);
  } finally {
    await harness.close();
  }
});

test("cursor migration preserves recaps from an existing database", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE recaps (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, summary TEXT NOT NULL, automatic INTEGER NOT NULL, generated_at INTEGER NOT NULL, turns INTEGER NOT NULL, model TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0)`);
  db.prepare("INSERT INTO recaps VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy", "source", "Earlier decisions", 0, 100, 4, "p/m", 0);
  const harness = await createHarness({ database: db });
  try {
    assert.equal((db.prepare("SELECT last_user_row_id FROM recaps WHERE id = 'legacy'").get() as { last_user_row_id: null }).last_user_row_id, null);
    await harness.handlers.recap_settings_set({ ...harness.settings, auto: false });
    const generated = await harness.handlers.recap_generate({ threadId: "source", automatic: false });
    assert.match(harness.spawned[0].prompt, /Earlier decisions/);
    assert.equal(generated.recap?.lastUserRowId, "source-user");
  } finally {
    await harness.close();
  }
});

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
