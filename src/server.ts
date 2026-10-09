import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildConversationText,
  buildRecapPrompt,
  buildRecapWorkerInput,
  cleanRecapText,
  countUserTurns,
  GENERATION_REASON_OPTIONS,
  latestUserRowId,
  MAX_RECAP_CHARS,
  MAX_RECAP_PROMPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  parsePositiveInteger,
  createGenerationLimiter,
  GENERATION_REASONS,
  isRunningThreadStatus,
  isVisibleThread,
  MAX_CONCURRENT_GENERATIONS,
  MIN_CONCURRENT_GENERATIONS,
  mergeRecapSettingsPatch,
  normalizeRecapSettings,
  recapSettingsFormPatch,
  RECAP_DISPLAY_MODES,
  RECAP_WORKER_PERMISSION_MODE,
  shouldRetryAutomaticRecap,
  SQL_CLEANUP_RECAPS,
  SQL_ADD_RECAP_CURSOR,
  SQL_CREATE_INVALIDATIONS,
  SQL_CREATE_RECAPS,
  SQL_CREATE_RECAPS_INDEX,
  SQL_HAS_RECAP_FOR_CURSOR,
  SQL_INSERT_RECAP,
  SQL_LATEST_RECAP,
  SQL_LATEST_RECAP_ANY,
  SQL_LIST_RECAPS,
  SQL_UPSERT_INVALIDATION,
} from "./recap.ts";
import type { GenerationReason } from "./recap.ts";

const MAX_ID_CHARS = 256;
const MAX_STORED_RECAPS = 1_000;
const RETRY_AFTER_MS = 90_000;
const WORKER_TIMEOUT_MS = 120_000;
const RECAP_CHANGED = "recap-changed";
const MODEL_SELECTION_KEY = "model-selection";
const SETTINGS_KEY = "settings";

const recapSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_CHARS),
    threadId: z.string().min(1).max(MAX_ID_CHARS),
    summary: z.string().max(MAX_RECAP_CHARS),
    automatic: z.boolean(),
    generatedAt: z.number(),
    turns: z.number(),
    lastUserRowId: z.string().nullable(),
    model: z
      .string()
      .min(1)
      .max(MAX_ID_CHARS * 2),
    suppressed: z.boolean(),
  })
  .strict();
export type Recap = z.infer<typeof recapSchema>;

type BbReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "ultracode";
type BbServiceTier = "default" | "fast";

const modelSelectionSchema = z
  .object({
    providerId: z.string().min(1).max(MAX_ID_CHARS),
    model: z.string().min(1).max(MAX_ID_CHARS),
    reasoningLevel: z.enum([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "ultracode",
    ]),
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const displayModeSchema = z.enum([
  RECAP_DISPLAY_MODES.compact,
  RECAP_DISPLAY_MODES.card,
  RECAP_DISPLAY_MODES.onDemand,
]);

const recapSettingsSchema = z
  .object({
    auto: z.boolean(),
    autoCleanup: z.boolean(),
    afterSeconds: z.number().int().min(0).max(86_400),
    minTurns: z.number().int().min(1).max(100),
    maxConcurrent: z
      .number()
      .int()
      .min(MIN_CONCURRENT_GENERATIONS)
      .max(MAX_CONCURRENT_GENERATIONS),
    displayMode: displayModeSchema,
    prompt: z.string().max(MAX_RECAP_PROMPT_CHARS),
  })
  .strict();

export const rpcContract = defineRpcContract({
  recap_get: {
    input: z.object({ threadId: z.string().min(1).max(MAX_ID_CHARS) }).strict(),
    output: z
      .object({ recap: recapSchema.nullable(), generating: z.boolean() })
      .strict(),
  },
  recap_generate: {
    input: z
      .object({
        threadId: z.string().min(1).max(MAX_ID_CHARS),
        automatic: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        recap: recapSchema.nullable(),
        generated: z.boolean(),
        suppressed: z.boolean(),
        reason: z.enum(GENERATION_REASON_OPTIONS).nullable(),
        turns: z.number().nullable(),
      })
      .strict(),
  },
  recap_model_get: {
    input: z.object({}).strict(),
    output: z
      .object({
        selection: modelSelectionSchema.nullable(),
        configured: z.boolean(),
      })
      .strict(),
  },
  recap_model_set: {
    input: modelSelectionSchema,
    output: z.object({ selection: modelSelectionSchema }).strict(),
  },
  recap_settings_get: {
    input: z.object({}).strict(),
    output: recapSettingsSchema,
  },
  recap_settings_set: {
    input: recapSettingsSchema,
    output: recapSettingsSchema,
  },
  recap_display_mode_set: {
    input: z.object({ displayMode: displayModeSchema }).strict(),
    output: z.object({ displayMode: displayModeSchema }).strict(),
  },
});

export type RecapSettings = z.infer<typeof recapSettingsSchema>;

type ThreadSnapshot = {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  status: string;
  visibility: "visible" | "hidden";
  originPluginId: string | null;
  originKind?: "fork" | null;
  parentThreadId?: string | null;
};

type ThreadState = {
  timer?: ReturnType<typeof setTimeout>;
  epoch: number;
  inFlight: boolean;
  lastAutoUserRowId: string | null;
  idleThread?: ThreadSnapshot;
  autoRetryCount: number;
  scheduleGeneration: number;
  generationController?: AbortController;
  generationPromise?: Promise<GenerationResult>;
  retired?: boolean;
};

type GenerationResult = {
  recap: Recap | null;
  generated: boolean;
  suppressed: boolean;
  reason: GenerationReason | null;
  turns: number | null;
};

type StoredRecapRow = {
  id: string;
  thread_id: string;
  summary: string;
  automatic: number;
  generated_at: number;
  turns: number;
  model: string;
  suppressed: number;
  last_user_row_id: string | null;
};

function result(
  reason: GenerationReason | null,
  turns: number | null = null,
): GenerationResult {
  return { recap: null, generated: false, suppressed: false, reason, turns };
}

function rowToRecap(row: StoredRecapRow): Recap {
  return {
    id: row.id,
    threadId: row.thread_id,
    summary: row.summary,
    automatic: row.automatic === 1,
    generatedAt: row.generated_at,
    turns: row.turns,
    lastUserRowId: row.last_user_row_id,
    model: row.model,
    suppressed: row.suppressed === 1,
  };
}

function parseStoredSettings(value: unknown): RecapSettings {
  return normalizeRecapSettings(value);
}

function parseStoredModelSelection(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isRecapEventTarget(thread: ThreadSnapshot, pluginId: string): boolean {
  return isVisibleThread(thread.visibility) && thread.originPluginId !== pluginId;
}

type ProviderCatalog = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>;

function normalizeModelSelection(
  selection: ModelSelection,
  model: ProviderCatalog["models"][number],
  provider: ProviderCatalog["providers"][number] | undefined,
): ModelSelection {
  const supported = model.supportedReasoningEfforts.map(
    (effort) => effort.reasoningEffort,
  );
  const serviceTier =
    selection.serviceTier &&
    provider?.serviceTiers?.some((tier) => tier.id === selection.serviceTier)
      ? selection.serviceTier
      : undefined;
  return {
    providerId: selection.providerId,
    model: model.model,
    reasoningLevel:
      supported.length > 0 && !supported.includes(selection.reasoningLevel)
        ? model.defaultReasoningEffort
        : selection.reasoningLevel,
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    SQL_CREATE_RECAPS,
    SQL_CREATE_RECAPS_INDEX,
    SQL_CREATE_INVALIDATIONS,
    SQL_ADD_RECAP_CURSOR,
  ]);

  let config = parseStoredSettings(await bb.storage.kv.get(SETTINGS_KEY));
  let modelSelection = parseStoredModelSelection(
    await bb.storage.kv.get(MODEL_SELECTION_KEY),
  );
  const states = new Map<string, ThreadState>();
  const generationLimiter = createGenerationLimiter(config.maxConcurrent);
  let disposed = false;
  // Thread-change events omit visibility, so verify it from the current snapshot.
  const unsubscribeThreadChanges = bb.sdk.subscribe({
    event: "thread:changed",
    callback: ({ id }) => {
      if (!id || disposed) return;
      const controller = states.get(id)?.generationController;
      if (!controller || controller.signal.aborted) return;
      void bb.sdk.threads
        .get({ threadId: id, signal: controller.signal })
        .then((thread) => {
          if (!isVisibleThread(thread.visibility)) controller.abort();
        })
        .catch(() => {});
    },
  });

  const publishChanged = (payload: Record<string, unknown>) => {
    if (disposed) return;
    try {
      bb.realtime.publish(RECAP_CHANGED, payload);
    } catch {
      // The host can invalidate handles while an asynchronous operation unwinds.
    }
  };

  const logWarning = (message: string) => {
    if (disposed) return;
    try {
      bb.log.warn(message);
    } catch {
      // Logging is best effort during plugin disposal.
    }
  };

  const stateFor = (threadId: string): ThreadState => {
    const existing = states.get(threadId);
    if (existing) return existing;
    const created: ThreadState = {
      epoch: 0,
      inFlight: false,
      lastAutoUserRowId: null,
      autoRetryCount: 0,
      scheduleGeneration: 0,
    };
    states.set(threadId, created);
    return created;
  };

  const clearTimer = (state: ThreadState) => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const CHILD_LIST_PAGE_SIZE = 100;
  const MAX_CHILD_LIST_PAGES = 20;
  const MAX_ANCESTOR_DEPTH = 8;

  // Spawned children keep working after the parent turn goes idle. Forks are a
  // separate conversation, and this plugin's own workers are not user work.
  const hasRunningChildThreads = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const seen = new Set<string>([threadId]);
    const visit = async (id: string, depth: number): Promise<boolean> => {
      if (signal?.aborted || depth > MAX_ANCESTOR_DEPTH) return false;
      let offset = 0;
      for (let page = 0; page < MAX_CHILD_LIST_PAGES; page += 1) {
        let children;
        try {
          children = await bb.sdk.threads.list({
            parentThreadId: id,
            includeHidden: true,
            archived: false,
            limit: CHILD_LIST_PAGE_SIZE,
            offset,
            signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          logWarning(
            `Could not list child threads for ${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
        for (const child of children) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          if (child.originKind === "fork" || child.originPluginId === bb.pluginId)
            continue;
          if (child.archivedAt != null || child.deletedAt != null) continue;
          if (isRunningThreadStatus(child.status)) return true;
          if (await visit(child.id, depth + 1)) return true;
        }
        if (children.length < CHILD_LIST_PAGE_SIZE) return false;
        offset += children.length;
      }
      return false;
    };
    return visit(threadId, 0);
  };

  const eachAncestor = async (
    thread: ThreadSnapshot,
    visit: (state: ThreadState) => void,
  ) => {
    if (
      !thread.parentThreadId ||
      thread.originKind === "fork" ||
      thread.originPluginId === bb.pluginId
    )
      return;
    let parentId: string | null = thread.parentThreadId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId) && seen.size < MAX_ANCESTOR_DEPTH) {
      if (disposed) return;
      seen.add(parentId);
      const state = states.get(parentId);
      if (state && !state.retired) visit(state);
      try {
        const parent = (await bb.sdk.threads.get({
          threadId: parentId,
        })) as ThreadSnapshot;
        parentId = parent.parentThreadId ?? null;
      } catch {
        return;
      }
    }
  };

  const holdAncestorsForRunningChild = (thread: ThreadSnapshot) => {
    if (!isRunningThreadStatus(thread.status)) return;
    void eachAncestor(thread, (state) => {
      state.scheduleGeneration += 1;
      clearTimer(state);
      if (!state.inFlight) return;
      state.generationController?.abort();
      state.epoch += 1;
    });
  };

  const latestRecap = (threadId: string): Recap | null => {
    const row = db.prepare(SQL_LATEST_RECAP).get(threadId) as
      | StoredRecapRow
      | undefined;
    return row ? rowToRecap(row) : null;
  };

  const latestUsableRecap = (threadId: string): Recap | null => {
    const row = db.prepare(SQL_LATEST_RECAP_ANY).get(threadId) as
      | StoredRecapRow
      | undefined;
    return row ? rowToRecap(row) : null;
  };

  const listRecaps = (limit: number): Recap[] => {
    const rows = db.prepare(SQL_LIST_RECAPS).all(limit) as StoredRecapRow[];
    return rows.map(rowToRecap);
  };

  const cleanupStoredRecaps = () => {
    db.prepare(SQL_CLEANUP_RECAPS).run(MAX_STORED_RECAPS);
  };

  if (config.autoCleanup) cleanupStoredRecaps();

  const hasRecapForCursor = (threadId: string, cursor: string | null): boolean => {
    if (cursor === null) return false;
    const row = db.prepare(SQL_HAS_RECAP_FOR_CURSOR).get(threadId, cursor) as
      | { present: number }
      | undefined;
    return row !== undefined;
  };

  const invalidateRecap = (threadId: string) => {
    db.prepare(SQL_UPSERT_INVALIDATION).run(threadId, Date.now());
    publishChanged({ threadId, invalidated: true });
  };

  const saveRecap = (
    threadId: string,
    summary: string,
    automatic: boolean,
    turns: number,
    model: string,
    suppressed: boolean,
    lastUserRowId: string | null,
  ): Recap => {
    const stored: Recap = {
      id: randomUUID(),
      threadId,
      summary,
      automatic,
      generatedAt: Date.now(),
      turns,
      model,
      suppressed,
      lastUserRowId,
    };
    db.prepare(SQL_INSERT_RECAP).run(
      stored.id,
      stored.threadId,
      stored.summary,
      stored.automatic ? 1 : 0,
      stored.generatedAt,
      stored.turns,
      stored.model,
      stored.suppressed ? 1 : 0,
      stored.lastUserRowId,
    );
    if (config.autoCleanup) {
      cleanupStoredRecaps();
    }
    publishChanged({ threadId });
    return stored;
  };

  const readTimeline = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> => {
    const pages: unknown[][] = [];
    let before: { id: string; seq: number } | undefined;

    for (let page = 0; page < 20; page += 1) {
      const response = await bb.sdk.threads.timeline({
        threadId,
        includeNestedRows: "true",
        ...(before
          ? { beforeAnchorId: before.id, beforeAnchorSeq: String(before.seq) }
          : {}),
        signal,
      });
      pages.unshift(response.rows);
      if (
        buildConversationText(pages.flat(), MAX_TRANSCRIPT_CHARS).length >=
        MAX_TRANSCRIPT_CHARS
      )
        break;
      if (
        !response.timelinePage.hasOlderRows ||
        response.timelinePage.olderCursor === null
      )
        break;
      before = {
        id: response.timelinePage.olderCursor.anchorId,
        seq: response.timelinePage.olderCursor.anchorSeq,
      };
    }
    return pages.flat();
  };

  const mainDefaultSelection = async (
    signal?: AbortSignal,
  ): Promise<ModelSelection | null> => {
    const options = await bb.sdk.system.executionOptions({ signal });
    const model =
      options.models.find((candidate) => candidate.isDefault) ??
      options.models[0];
    const providerId =
      model?.routeProviderId ??
      options.providers.find((provider) => provider.available)?.id;
    if (!model || !providerId) return null;
    return {
      providerId,
      model: model.model,
      reasoningLevel: model.defaultReasoningEffort,
    };
  };

  const currentModelSelection = async () => ({
    selection: modelSelection ?? (await mainDefaultSelection()),
    configured: modelSelection !== undefined,
  });

  const resolveExecution = async (
    thread: ThreadSnapshot,
    signal?: AbortSignal,
  ) => {
    const preferred = modelSelection ?? (await mainDefaultSelection(signal));
    if (!preferred) throw new Error("No default BB model is available.");

    const providerId = preferred.providerId;
    const catalog = await bb.sdk.providers.models(
      thread.environmentId
        ? { environmentId: thread.environmentId, providerId, signal }
        : { providerId, signal },
    );
    let modelInfo = catalog.models.find(
      (candidate) =>
        candidate.model === preferred.model || candidate.id === preferred.model,
    );
    if (!modelInfo) {
      logWarning(
        "Recap model " +
          JSON.stringify(preferred.model) +
          " is unavailable for provider " +
          providerId +
          "; using that provider's default.",
      );
      modelInfo =
        catalog.models.find((candidate) => candidate.isDefault) ??
        catalog.models[0];
    }
    if (!modelInfo)
      throw new Error("No model is available for provider " + providerId + ".");

    const provider = catalog.providers.find(
      (candidate) => candidate.id === providerId,
    );
    return normalizeModelSelection(preferred, modelInfo, provider);
  };

  const disposeWorker = async (threadId: string) => {
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch {
      // The worker may already have failed or been archived.
    }
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch {
      // Stopping is best effort after the result has been collected.
    }
  };

  const runWorker = async (
    thread: ThreadSnapshot,
    input: { transcript: string; previousRecap?: string },
    execution: {
      providerId: string;
      model: string;
      reasoningLevel: BbReasoningLevel;
      serviceTier?: BbServiceTier;
    },
    signal?: AbortSignal,
  ): Promise<string> => {
    if (signal?.aborted) return "";
    const worker = await bb.sdk.threads.spawn({
      projectId: thread.projectId,
      environment: thread.environmentId
        ? { type: "reuse", environmentId: thread.environmentId }
        : { type: "project-default" },
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
      permissionMode: RECAP_WORKER_PERMISSION_MODE,
      title: "Recap worker",
      visibility: "hidden",
      prompt: buildRecapPrompt(
        config.prompt,
        input.transcript,
        input.previousRecap,
      ),
    });

    try {
      if (signal?.aborted) return "";
      await bb.sdk.threads.wait({
        threadId: worker.id,
        status: "idle",
        timeoutMs: WORKER_TIMEOUT_MS,
        signal,
      });
      if (signal?.aborted) return "";
      return (
        (await bb.sdk.threads.output({ threadId: worker.id, signal })).output ??
        ""
      );
    } finally {
      await disposeWorker(worker.id);
    }
  };

  const generateForThread = async (
    threadId: string,
    automatic: boolean,
    expectedEpoch?: number,
    signal?: AbortSignal,
  ): Promise<GenerationResult> => {
    if (signal?.aborted) return result("aborted");
    if (automatic && !config.auto) return result("automatic_disabled");
    const thread = (await bb.sdk.threads.get({
      threadId,
      signal,
    })) as ThreadSnapshot;
    if (!isVisibleThread(thread.visibility)) return result("hidden_thread");
    const state = stateFor(threadId);
    if (thread.status !== "idle" || (await hasRunningChildThreads(threadId, signal)))
      return result("thread_not_idle");
    if (expectedEpoch !== undefined && state.epoch !== expectedEpoch)
      return result("stale");

    const rows = await readTimeline(threadId, signal);
    const turns = countUserTurns(rows, threadId);
    const cursor = latestUserRowId(rows, threadId);
    if (automatic && turns < config.minTurns)
      return result("not_enough_turns", turns);
    const previous = latestUsableRecap(threadId);
    const input = buildRecapWorkerInput(rows, previous, threadId);
    if (input.transcript === "") return result("no_conversation", turns);
    if (
      automatic &&
      ((cursor !== null && cursor === state.lastAutoUserRowId) ||
        hasRecapForCursor(threadId, cursor))
    ) {
      return { ...result("already_exists", turns), generated: true };
    }

    const execution = await resolveExecution(thread, signal);
    // Close the async setup window even if a realtime notification was missed.
    const beforeWorker = (await bb.sdk.threads.get({
      threadId,
      signal,
    })) as ThreadSnapshot;
    if (!isVisibleThread(beforeWorker.visibility))
      return result("hidden_thread", turns);
    if (
      beforeWorker.status !== "idle" ||
      (expectedEpoch !== undefined && state.epoch !== expectedEpoch) ||
      (await hasRunningChildThreads(threadId, signal))
    ) {
      return result("stale", turns);
    }
    if (signal?.aborted) return result("aborted", turns);
    if (automatic && !config.auto) return result("automatic_disabled", turns);
    const raw = await runWorker(beforeWorker, input, execution, signal);
    if (signal?.aborted) return result("aborted", turns);
    const summary = cleanRecapText(raw);
    if (summary === "") return result("empty_model_response", turns);

    const current = (await bb.sdk.threads.get({
      threadId,
      signal,
    })) as ThreadSnapshot;
    if (!isVisibleThread(current.visibility))
      return result("hidden_thread", turns);
    if (
      current.status !== "idle" ||
      (expectedEpoch !== undefined && state.epoch !== expectedEpoch) ||
      (await hasRunningChildThreads(threadId, signal))
    ) {
      return result("stale", turns);
    }
    const latestRows = await readTimeline(threadId, signal);
    const latestTurns = countUserTurns(latestRows, threadId);
    if (signal?.aborted) return result("aborted", latestTurns);
    if (latestTurns !== turns || latestUserRowId(latestRows, threadId) !== cursor)
      return result("stale", latestTurns);
    if (automatic && hasRecapForCursor(threadId, cursor)) {
      return { ...result("already_exists", turns), generated: true };
    }

    const suppressed =
      automatic &&
      (raw.length > 500 ||
        (summary.endsWith("…") && summary.length >= MAX_RECAP_CHARS));
    const recap = saveRecap(
      threadId,
      suppressed ? "" : summary,
      automatic,
      turns,
      `${execution.providerId}/${execution.model}`,
      suppressed,
      cursor,
    );
    if (automatic) state.lastAutoUserRowId = cursor;
    if (suppressed)
      return {
        recap: null,
        generated: true,
        suppressed: true,
        reason: "suppressed",
        turns,
      };
    return { recap, generated: true, suppressed: false, reason: null, turns };
  };

  const beginGeneration = (
    threadId: string,
    automatic: boolean,
    expectedEpoch?: number,
    signal?: AbortSignal,
  ): Promise<GenerationResult> => {
    const state = stateFor(threadId);
    if (state.inFlight) return Promise.resolve(result("already_generating"));
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    state.inFlight = true;
    state.generationController = controller;
    publishChanged({ threadId, generating: true });
    const generationPromise = (async () => {
      let acquired = false;
      try {
        const slot = await generationLimiter.acquire(combinedSignal);
        if (slot === "aborted") return result("aborted");
        acquired = true;
        if (combinedSignal.aborted) return result("aborted");
        return await generateForThread(
          threadId,
          automatic,
          expectedEpoch,
          combinedSignal,
        );
      } catch (error) {
        if (combinedSignal.aborted) return result("aborted");
        throw error;
      } finally {
        if (acquired) generationLimiter.release();
        state.inFlight = false;
        state.generationController = undefined;
        state.generationPromise = undefined;
        publishChanged({ threadId, generating: false });
        if (state.retired || (!state.timer && !state.idleThread))
          states.delete(threadId);
      }
    })();
    state.generationPromise = generationPromise;
    return generationPromise;
  };

  const scheduleAutomaticRecap = (
    thread: ThreadSnapshot,
    delay = config.afterSeconds * 1000,
    retry = false,
  ) => {
    if (disposed) return;
    const state = stateFor(thread.id);
    clearTimer(state);
    state.idleThread = thread;
    if (!retry) state.autoRetryCount = 0;
    state.scheduleGeneration += 1;
    if (!config.auto || thread.status !== "idle") return;
    const token = state.scheduleGeneration;
    const epoch = state.epoch;
    void (async () => {
      let childrenRunning = false;
      try {
        childrenRunning = await hasRunningChildThreads(thread.id);
      } catch (error) {
        logWarning(
          `Could not check child threads for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const current = states.get(thread.id);
      if (
        disposed ||
        !current ||
        current.retired ||
        current.scheduleGeneration !== token ||
        current.epoch !== epoch ||
        !current.idleThread ||
        !config.auto ||
        childrenRunning
      )
        return;
      current.timer = setTimeout(() => {
        current.timer = undefined;
        if (
          disposed ||
          current.scheduleGeneration !== token ||
          current.epoch !== epoch
        )
          return;
        void beginGeneration(thread.id, true, epoch)
          .then((generation) => {
            const latest = states.get(thread.id);
            if (!latest || latest.epoch !== epoch) return;
            if (generation.generated && generation.turns !== null) {
              latest.autoRetryCount = 0;
            }
            if (generation.reason === "thread_not_idle" && latest.idleThread) {
              scheduleAutomaticRecap(latest.idleThread);
              return;
            }
            if (
              latest.idleThread &&
              shouldRetryAutomaticRecap({
                generated: generation.generated,
                reason: generation.reason,
                retryCount: latest.autoRetryCount,
              })
            ) {
              latest.autoRetryCount += 1;
              scheduleAutomaticRecap(latest.idleThread, RETRY_AFTER_MS, true);
            }
          })
          .catch((error: unknown) => {
            logWarning(
              `Automatic recap failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            const latest = states.get(thread.id);
            if (
              !disposed &&
              latest &&
              latest.epoch === epoch &&
              latest.idleThread &&
              shouldRetryAutomaticRecap({
                generated: false,
                reason: null,
                retryCount: latest.autoRetryCount,
              })
            ) {
              latest.autoRetryCount += 1;
              scheduleAutomaticRecap(latest.idleThread, RETRY_AFTER_MS, true);
            }
          });
      }, Math.max(0, delay));
    })();
  };

  const reconsiderAncestors = (thread: ThreadSnapshot) => {
    void eachAncestor(thread, (state) => {
      if (state.idleThread) scheduleAutomaticRecap(state.idleThread);
    });
  };

  const rearmAfterManual = async (
    threadId: string,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted || disposed) return;
    try {
      const thread = (await bb.sdk.threads.get({
        threadId,
        signal,
      })) as ThreadSnapshot;
      if (!isRecapEventTarget(thread, bb.pluginId) || thread.status !== "idle")
        return;
      scheduleAutomaticRecap(thread);
    } catch {
      // The thread may have been deleted while the manual request completed.
    }
  };

  let persistQueue = Promise.resolve();
  const persistSettings = (
    patch: Partial<RecapSettings>,
  ): Promise<RecapSettings> => {
    const run = persistQueue.then(async () => {
      const next = mergeRecapSettingsPatch(config, patch);
      await bb.storage.kv.set(SETTINGS_KEY, next);
      config = next;
      generationLimiter.setLimit(config.maxConcurrent);
      if (config.autoCleanup) cleanupStoredRecaps();
      publishChanged({ settings: true });
      for (const state of states.values()) {
        if (!config.auto) clearTimer(state);
        if (!state.inFlight && state.idleThread)
          scheduleAutomaticRecap(state.idleThread);
      }
      return next;
    });
    persistQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  bb.rpc.register(rpcContract, {
    recap_get: async ({ threadId }) => ({
      recap: latestRecap(threadId),
      generating: stateFor(threadId).inFlight,
    }),
    recap_model_get: async () => currentModelSelection(),
    recap_model_set: async (selection) => {
      const catalog = await bb.sdk.providers.models({
        providerId: selection.providerId,
      });
      const modelInfo = catalog.models.find(
        (candidate) =>
          candidate.model === selection.model ||
          candidate.id === selection.model,
      );
      if (!modelInfo)
        throw new Error(
          "Model " +
            selection.model +
            " is unavailable for provider " +
            selection.providerId +
            ".",
        );

      const provider = catalog.providers.find(
        (candidate) => candidate.id === selection.providerId,
      );
      const stored = normalizeModelSelection(selection, modelInfo, provider);
      await bb.storage.kv.set(MODEL_SELECTION_KEY, stored);
      modelSelection = stored;
      publishChanged({ settings: true });
      return { selection: stored };
    },
    recap_settings_get: async () => parseStoredSettings(config),
    recap_settings_set: async (next) =>
      persistSettings(recapSettingsFormPatch(next)),
    recap_display_mode_set: async ({ displayMode }) => {
      const saved = await persistSettings({ displayMode });
      return { displayMode: saved.displayMode };
    },
    recap_generate: async ({ threadId, automatic }) => {
      const isAutomatic = automatic === true;
      const generation = await beginGeneration(threadId, isAutomatic);
      if (!isAutomatic) await rearmAfterManual(threadId);
      if (!isAutomatic && generation.reason === "thread_not_idle") {
        throw new Error(GENERATION_REASONS.thread_not_idle);
      }
      return {
        recap: generation.recap,
        generated: generation.generated,
        suppressed: generation.suppressed,
        reason: generation.reason,
        turns: generation.turns,
      };
    },
  });

  const usage = [
    "Usage:",
    "  bb recap recap [thread-id] [--json]",
    "  bb recap summarize [thread-id] [--json]",
    "  bb recap show [thread-id] [--json]",
    "  bb recap list [--limit N] [--json]",
    "",
    "Leave thread-id out when running from a thread-aware BB CLI context.",
  ].join("\n");
  const cliError = (message: string) => ({
    exitCode: 1,
    stderr: `${message}\n\n${usage}`,
  });

  bb.cli.register({
    name: "recap",
    summary: "Generate and review concise recaps of BB threads",
    commands: [
      {
        name: "recap",
        summary: "Generate a recap",
        usage: "bb recap recap [thread-id] [--json]",
      },
      {
        name: "summarize",
        summary: "Alias for recap",
        usage: "bb recap summarize [thread-id] [--json]",
      },
      {
        name: "show",
        summary: "Show the latest recap",
        usage: "bb recap show [thread-id] [--json]",
      },
      {
        name: "list",
        summary: "List generated recaps",
        usage: "bb recap list [--limit N] [--json]",
      },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const command = args.shift();
      if (command === undefined || command === "help" || command === "--help")
        return { exitCode: 0, stdout: usage };

      if (command === "list") {
        let limit = 50;
        if (args.length === 2 && args[0] === "--limit") {
          const parsed = parsePositiveInteger(args[1]);
          if (parsed === null)
            return cliError("--limit must be a positive integer.");
          limit = Math.min(parsed, 100);
        } else if (args.length > 0) {
          return cliError("Unknown list arguments.");
        }
        const recaps = listRecaps(limit);
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(recaps)
            : recaps.length === 0
              ? "No recaps yet."
              : recaps
                  .map(
                    (recap) =>
                      `[${new Date(recap.generatedAt).toISOString()}] ${recap.threadId}  ${recap.summary}`,
                  )
                  .join("\n"),
        };
      }

      if (!["recap", "summarize", "show"].includes(command) || args.length > 1)
        return cliError("Unknown arguments.");
      const threadId = args[0] ?? context.threadId;
      if (!threadId)
        return cliError(
          "A thread id is required outside a thread-aware CLI context.",
        );

      if (command === "show") {
        const recap = latestRecap(threadId);
        if (!recap)
          return { exitCode: 1, stderr: `No recap for thread ${threadId}.` };
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(recap) : recap.summary,
        };
      }

      const generation = await beginGeneration(
        threadId,
        false,
        undefined,
        context.signal,
      );
      await rearmAfterManual(threadId, context.signal);
      if (!generation.recap) {
        const message =
          generation.reason === "thread_not_idle"
            ? GENERATION_REASONS.thread_not_idle
            : generation.reason === "hidden_thread"
              ? "Recaps cannot be generated for hidden threads."
              : `Could not generate a recap (${generation.reason ?? "unknown error"}).`;
        return { exitCode: 1, stderr: message };
      }
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(generation.recap)
          : generation.recap.summary,
      };
    },
  });

  bb.events.on("thread.created", ({ thread }) => {
    holdAncestorsForRunningChild(thread);
  });

  bb.events.on("thread.active", ({ thread }) => {
    holdAncestorsForRunningChild(thread);
    if (!isRecapEventTarget(thread, bb.pluginId)) return;
    invalidateRecap(thread.id);
    const state = states.get(thread.id);
    if (state) {
      state.scheduleGeneration += 1;
      state.generationController?.abort();
      state.epoch += 1;
      state.lastAutoUserRowId = null;
      state.idleThread = undefined;
      clearTimer(state);
      if (!state.inFlight) states.delete(thread.id);
    }
  });

  bb.events.on("thread.idle", ({ thread }) => {
    reconsiderAncestors(thread);
    if (!isRecapEventTarget(thread, bb.pluginId)) return;
    scheduleAutomaticRecap(thread);
  });

  bb.events.on("thread.failed", ({ thread }) => {
    const state = states.get(thread.id);
    if (state) {
      state.scheduleGeneration += 1;
      state.generationController?.abort();
      state.epoch += 1;
      state.idleThread = undefined;
      clearTimer(state);
    }
    reconsiderAncestors(thread);
  });

  const removeThreadState = ({ thread }: { thread: ThreadSnapshot }) => {
    const state = states.get(thread.id);
    if (state) {
      state.retired = true;
      state.scheduleGeneration += 1;
      state.generationController?.abort();
      clearTimer(state);
      state.idleThread = undefined;
      if (!state.inFlight) states.delete(thread.id);
    }
    reconsiderAncestors(thread);
  };
  bb.events.on("thread.archived", removeThreadState);
  bb.events.on("thread.deleted", removeThreadState);

  bb.onDispose(async () => {
    disposed = true;
    unsubscribeThreadChanges();
    const pending: Promise<unknown>[] = [];
    for (const state of states.values()) clearTimer(state);
    for (const state of states.values()) {
      state.generationController?.abort();
      if (state.generationPromise) pending.push(state.generationPromise);
    }
    await Promise.allSettled(pending);
    states.clear();
  });

  bb.log.info("loaded");
}
