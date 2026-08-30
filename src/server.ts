import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildConversationText,
  buildRecapPrompt,
  cleanRecapText,
  countUserTurns,
  MAX_RECAP_CHARS,
  MAX_RECAP_PROMPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  normalizeRecapPrompt,
  parseDisplayMode,
  parseBoundedInteger,
  parsePositiveInteger,
  RECAP_DISPLAY_MODES,
} from "./recap.js";

const DEFAULT_AFTER_SECONDS = 30;
const DEFAULT_MIN_TURNS = 3;
const MAX_ID_CHARS = 256;
const MAX_STORED_RECAPS = 1_000;
const RETRY_AFTER_MS = 90_000;
const WORKER_TIMEOUT_MS = 120_000;
const RECAP_CHANGED = "recap-changed";
const MODEL_SELECTION_KEY = "model-selection";
const SETTINGS_KEY = "settings";

const recapSchema = z.object({
  id: z.string().min(1).max(MAX_ID_CHARS),
  threadId: z.string().min(1).max(MAX_ID_CHARS),
  summary: z.string().max(MAX_RECAP_CHARS),
  automatic: z.boolean(),
  generatedAt: z.number(),
  turns: z.number(),
  model: z.string().min(1).max(MAX_ID_CHARS * 2),
  suppressed: z.boolean(),
}).strict();
export type Recap = z.infer<typeof recapSchema>;

type BbReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode";
type BbServiceTier = "default" | "fast";

const modelSelectionSchema = z.object({
  providerId: z.string().min(1).max(MAX_ID_CHARS),
  model: z.string().min(1).max(MAX_ID_CHARS),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  serviceTier: z.enum(["default", "fast"]).optional(),
}).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const displayModeSchema = z.enum([
  RECAP_DISPLAY_MODES.compact,
  RECAP_DISPLAY_MODES.card,
  RECAP_DISPLAY_MODES.onDemand,
]);

const recapSettingsSchema = z.object({
  auto: z.boolean(),
  autoCleanup: z.boolean(),
  afterSeconds: z.number().int().min(0).max(86_400),
  minTurns: z.number().int().min(1).max(100),
  displayMode: displayModeSchema,
  prompt: z.string().max(MAX_RECAP_PROMPT_CHARS),
}).strict();

export const rpcContract = defineRpcContract({
  recap_get: {
    input: z.object({ threadId: z.string().min(1).max(MAX_ID_CHARS) }).strict(),
    output: z.object({ recap: recapSchema.nullable(), generating: z.boolean() }).strict(),
  },
  recap_generate: {
    input: z.object({ threadId: z.string().min(1).max(MAX_ID_CHARS), automatic: z.boolean().optional() }).strict(),
    output: z.object({
      recap: recapSchema.nullable(),
      generated: z.boolean(),
      suppressed: z.boolean(),
      reason: z.string().nullable(),
      turns: z.number().nullable(),
    }).strict(),
  },
  recap_model_get: {
    input: z.object({}).strict(),
    output: z.object({
      selection: modelSelectionSchema.nullable(),
      configured: z.boolean(),
    }).strict(),
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
};

type ThreadState = {
  timer?: ReturnType<typeof setTimeout>;
  epoch: number;
  inFlight: boolean;
  lastAutoTurns: number;
  idleThread?: ThreadSnapshot;
  generationController?: AbortController;
  generationPromise?: Promise<GenerationResult>;
  retired?: boolean;
};

type GenerationResult = {
  recap: Recap | null;
  generated: boolean;
  suppressed: boolean;
  reason: string | null;
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
};

function result(reason: string | null, turns: number | null = null): GenerationResult {
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
    model: row.model,
    suppressed: row.suppressed === 1,
  };
}

function parseStoredSettings(value: unknown): RecapSettings {
  const stored = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    auto: typeof stored.auto === "boolean" ? stored.auto : true,
    autoCleanup: typeof stored.autoCleanup === "boolean" ? stored.autoCleanup : true,
    afterSeconds: parseBoundedInteger(
      typeof stored.afterSeconds === "number" || typeof stored.afterSeconds === "string"
        ? String(stored.afterSeconds)
        : "",
      DEFAULT_AFTER_SECONDS,
      0,
      86_400,
    ),
    minTurns: parseBoundedInteger(
      typeof stored.minTurns === "number" || typeof stored.minTurns === "string"
        ? String(stored.minTurns)
        : "",
      DEFAULT_MIN_TURNS,
      1,
      100,
    ),
    displayMode: parseDisplayMode(typeof stored.displayMode === "string" ? stored.displayMode : ""),
    prompt: normalizeRecapPrompt(stored.prompt),
  };
}

function parseStoredModelSelection(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isRecapEventTarget(thread: ThreadSnapshot, pluginId: string): boolean {
  return thread.visibility === "visible" && thread.originPluginId !== pluginId;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS recaps (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      automatic INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      turns INTEGER NOT NULL,
      model TEXT NOT NULL,
      suppressed INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS recaps_thread_generated_at ON recaps(thread_id, generated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS recap_invalidations (thread_id TEXT PRIMARY KEY, invalidated_at INTEGER NOT NULL)`,
  ]);

  let config = parseStoredSettings(await bb.storage.kv.get(SETTINGS_KEY));
  let modelSelection = parseStoredModelSelection(await bb.storage.kv.get(MODEL_SELECTION_KEY));
  const states = new Map<string, ThreadState>();
  let disposed = false;
  const bootstrapController = new AbortController();

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
    const created: ThreadState = { epoch: 0, inFlight: false, lastAutoTurns: 0 };
    states.set(threadId, created);
    return created;
  };

  const clearTimer = (state: ThreadState) => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const latestRecap = (threadId: string): Recap | null => {
    const row = db.prepare(
      `SELECT r.id, r.thread_id, r.summary, r.automatic, r.generated_at, r.turns, r.model, r.suppressed
       FROM recaps AS r
       LEFT JOIN recap_invalidations AS i ON i.thread_id = r.thread_id
       WHERE r.thread_id = ? AND r.suppressed = 0
         AND (i.invalidated_at IS NULL OR r.generated_at > i.invalidated_at)
       ORDER BY r.generated_at DESC, r.id DESC LIMIT 1`,
    ).get(threadId) as StoredRecapRow | undefined;
    return row ? rowToRecap(row) : null;
  };

  const listRecaps = (limit: number): Recap[] => {
    const rows = db.prepare(
      `SELECT id, thread_id, summary, automatic, generated_at, turns, model, suppressed
       FROM recaps WHERE suppressed = 0 ORDER BY generated_at DESC, id DESC LIMIT ?`,
    ).all(limit) as StoredRecapRow[];
    return rows.map(rowToRecap);
  };

  const cleanupStoredRecaps = () => {
    db.prepare(
      `DELETE FROM recaps
       WHERE suppressed = 1 OR id NOT IN (
         SELECT id FROM recaps
         WHERE suppressed = 0
         ORDER BY generated_at DESC, id DESC
         LIMIT ?
       )`,
    ).run(MAX_STORED_RECAPS);
  };

  if (config.autoCleanup) cleanupStoredRecaps();

  const hasRecapForTurns = (threadId: string, turns: number): boolean => {
    const row = db.prepare(
      `SELECT 1 AS present
       FROM recaps AS r
       LEFT JOIN recap_invalidations AS i ON i.thread_id = r.thread_id
       WHERE r.thread_id = ? AND r.turns = ? AND r.suppressed = 0
         AND (i.invalidated_at IS NULL OR r.generated_at > i.invalidated_at)
       LIMIT 1`,
    ).get(threadId, turns) as { present: number } | undefined;
    return row !== undefined;
  };

  const invalidateRecap = (threadId: string) => {
    db.prepare(
      `INSERT INTO recap_invalidations (thread_id, invalidated_at) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET invalidated_at = excluded.invalidated_at`,
    ).run(threadId, Date.now());
    publishChanged({ threadId, invalidated: true });
  };

  const saveRecap = (threadId: string, summary: string, automatic: boolean, turns: number, model: string, suppressed: boolean): Recap => {
    const stored: Recap = {
      id: randomUUID(),
      threadId,
      summary,
      automatic,
      generatedAt: Date.now(),
      turns,
      model,
      suppressed,
    };
    db.prepare(
      `INSERT INTO recaps (id, thread_id, summary, automatic, generated_at, turns, model, suppressed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      stored.id,
      stored.threadId,
      stored.summary,
      stored.automatic ? 1 : 0,
      stored.generatedAt,
      stored.turns,
      stored.model,
      stored.suppressed ? 1 : 0,
    );
    if (config.autoCleanup) {
      cleanupStoredRecaps();
    }
    publishChanged({ threadId });
    return stored;
  };

  const readTimeline = async (threadId: string, signal?: AbortSignal): Promise<unknown[]> => {
    const pages: unknown[][] = [];
    let before: { id: string; seq: number } | undefined;

    for (let page = 0; page < 20; page += 1) {
      const response = await bb.sdk.threads.timeline({
        threadId,
        includeNestedRows: "true",
        ...(before ? { beforeAnchorId: before.id, beforeAnchorSeq: String(before.seq) } : {}),
        signal,
      });
      pages.unshift(response.rows);
      if (buildConversationText(pages.flat(), MAX_TRANSCRIPT_CHARS).length >= MAX_TRANSCRIPT_CHARS) break;
      if (!response.timelinePage.hasOlderRows || response.timelinePage.olderCursor === null) break;
      before = {
        id: response.timelinePage.olderCursor.anchorId,
        seq: response.timelinePage.olderCursor.anchorSeq,
      };
    }
    return pages.flat();
  };

  const mainDefaultSelection = async (signal?: AbortSignal): Promise<ModelSelection | null> => {
    const options = await bb.sdk.system.executionOptions({ signal });
    const model = options.models.find((candidate) => candidate.isDefault) ?? options.models[0];
    const providerId = model?.routeProviderId ?? options.providers.find((provider) => provider.available)?.id;
    if (!model || !providerId) return null;
    return {
      providerId,
      model: model.model,
      reasoningLevel: model.defaultReasoningEffort,
    };
  };

  const currentModelSelection = async () => ({
    selection: modelSelection ?? await mainDefaultSelection(),
    configured: modelSelection !== undefined,
  });

  const resolveExecution = async (thread: ThreadSnapshot, signal?: AbortSignal) => {
    const preferred = modelSelection ?? await mainDefaultSelection(signal);
    if (!preferred) throw new Error("No default BB model is available.");

    const providerId = preferred.providerId;
    const catalog = await bb.sdk.providers.models(
      thread.environmentId
        ? { environmentId: thread.environmentId, providerId, signal }
        : { providerId, signal },
    );
    let modelInfo = catalog.models.find((candidate) => candidate.model === preferred.model || candidate.id === preferred.model);
    if (!modelInfo) {
      logWarning("Recap model " + JSON.stringify(preferred.model) + " is unavailable for provider " + providerId + "; using that provider's default.");
      modelInfo = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
    }
    if (!modelInfo) throw new Error("No model is available for provider " + providerId + ".");

    const supported = modelInfo.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
    const reasoningLevel = supported.length > 0 && !supported.includes(preferred.reasoningLevel)
      ? modelInfo.defaultReasoningEffort
      : preferred.reasoningLevel;
    const provider = catalog.providers.find((candidate) => candidate.id === providerId);
    const serviceTier = preferred.serviceTier && provider?.serviceTiers?.some((tier) => tier.id === preferred.serviceTier)
      ? preferred.serviceTier
      : undefined;
    return {
      providerId,
      model: modelInfo.model,
      reasoningLevel,
      ...(serviceTier ? { serviceTier } : {}),
    };
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
    transcript: string,
    execution: { providerId: string; model: string; reasoningLevel: BbReasoningLevel; serviceTier?: BbServiceTier },
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
      permissionMode: "accept-edits",
      title: "Recap worker",
      visibility: "hidden",
      prompt: buildRecapPrompt(config.prompt, transcript),
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
      return (await bb.sdk.threads.output({ threadId: worker.id, signal })).output ?? "";
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
    const thread = await bb.sdk.threads.get({ threadId, signal }) as ThreadSnapshot;
    const state = stateFor(threadId);
    if (thread.status !== "idle") return result("thread_not_idle");
    if (expectedEpoch !== undefined && state.epoch !== expectedEpoch) return result("stale");

    const rows = await readTimeline(threadId, signal);
    const turns = countUserTurns(rows, threadId);
    if (automatic && turns < config.minTurns) return result("not_enough_turns", turns);
    const transcript = buildConversationText(rows, MAX_TRANSCRIPT_CHARS);
    if (transcript === "") return result("no_conversation", turns);
    if (automatic && (turns <= state.lastAutoTurns || hasRecapForTurns(threadId, turns))) {
      return { ...result("already_exists", turns), generated: true };
    }

    const execution = await resolveExecution(thread, signal);
    const raw = await runWorker(thread, transcript, execution, signal);
    if (signal?.aborted) return result("aborted", turns);
    const summary = cleanRecapText(raw);
    if (summary === "") return result("empty_model_response", turns);

    const current = await bb.sdk.threads.get({ threadId, signal }) as ThreadSnapshot;
    if (current.status !== "idle" || (expectedEpoch !== undefined && state.epoch !== expectedEpoch)) {
      return result("stale", turns);
    }
    const latestTurns = countUserTurns(await readTimeline(threadId, signal), threadId);
    if (latestTurns !== turns) return result("stale", latestTurns);
    if (automatic && hasRecapForTurns(threadId, turns)) {
      return { ...result("already_exists", turns), generated: true };
    }

    const suppressed = automatic && (raw.length > 500 || (summary.endsWith("…") && summary.length >= MAX_RECAP_CHARS));
    const recap = saveRecap(
      threadId,
      suppressed ? "" : summary,
      automatic,
      turns,
      `${execution.providerId}/${execution.model}`,
      suppressed,
    );
    if (suppressed) return { recap: null, generated: true, suppressed: true, reason: "suppressed", turns };
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
      try {
        return await generateForThread(threadId, automatic, expectedEpoch, combinedSignal);
      } catch (error) {
        if (combinedSignal.aborted) return result("aborted");
        throw error;
      } finally {
        state.inFlight = false;
        state.generationController = undefined;
        state.generationPromise = undefined;
        publishChanged({ threadId, generating: false });
        if (state.retired || (!state.timer && !state.idleThread)) states.delete(threadId);
      }
    })();
    state.generationPromise = generationPromise;
    return generationPromise;
  };

  const scheduleAutomaticRecap = (thread: ThreadSnapshot, delay = config.afterSeconds * 1000) => {
    if (disposed) return;
    const state = stateFor(thread.id);
    clearTimer(state);
    state.idleThread = thread;
    if (!config.auto || thread.status !== "idle") return;
    const epoch = state.epoch;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (disposed) return;
      void beginGeneration(thread.id, true, epoch).then((generation) => {
        if (generation.generated && generation.turns !== null) state.lastAutoTurns = generation.turns;
        if (!generation.generated && !["not_enough_turns", "no_conversation", "stale", "already_generating", "aborted"].includes(generation.reason ?? "")) {
          if (state.epoch === epoch && state.idleThread) scheduleAutomaticRecap(state.idleThread, RETRY_AFTER_MS);
        }
      }).catch((error: unknown) => {
        logWarning(`Automatic recap failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!disposed && state.epoch === epoch && state.idleThread) scheduleAutomaticRecap(state.idleThread, RETRY_AFTER_MS);
      });
    }, Math.max(0, delay));
  };

  const bootstrapIdleThreads = async (signal: AbortSignal) => {
    if (!config.auto || disposed) return;
    let offset = 0;
    try {
      while (!signal.aborted && !disposed) {
        const threads = await bb.sdk.threads.list({
          archived: false,
          includeHidden: false,
          limit: 100,
          offset,
          signal,
        });
        for (const thread of threads) {
          const snapshot = thread as ThreadSnapshot;
          if (snapshot.status === "idle" && isRecapEventTarget(snapshot, bb.pluginId)) {
            scheduleAutomaticRecap(snapshot);
          }
        }
        if (threads.length < 100) break;
        offset += threads.length;
      }
    } catch (error) {
      if (!signal.aborted && !disposed) {
        logWarning(`Automatic recap bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const rearmAfterManual = async (threadId: string, generation: GenerationResult, signal?: AbortSignal) => {
    if (signal?.aborted || disposed) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId, signal }) as ThreadSnapshot;
      if (!isRecapEventTarget(thread, bb.pluginId) || thread.status !== "idle") return;
      const state = stateFor(threadId);
      if (generation.turns !== null && generation.generated) state.lastAutoTurns = generation.turns;
      scheduleAutomaticRecap(thread);
    } catch {
      // The thread may have been deleted while the manual request completed.
    }
  };

  const persistSettings = async (next: RecapSettings) => {
    const wasAuto = config.auto;
    await bb.storage.kv.set(SETTINGS_KEY, next);
    config = next;
    if (config.autoCleanup) cleanupStoredRecaps();
    publishChanged({ settings: true });
    for (const state of states.values()) {
      if (!state.inFlight && state.idleThread) scheduleAutomaticRecap(state.idleThread);
    }
    if (!wasAuto && config.auto) void bootstrapIdleThreads(bootstrapController.signal);
  };

  bb.rpc.register(rpcContract, {
    recap_get: async ({ threadId }) => ({
      recap: latestRecap(threadId),
      generating: stateFor(threadId).inFlight,
    }),
    recap_model_get: async () => currentModelSelection(),
    recap_model_set: async (selection) => {
      const catalog = await bb.sdk.providers.models({ providerId: selection.providerId });
      const modelInfo = catalog.models.find((candidate) => candidate.model === selection.model || candidate.id === selection.model);
      if (!modelInfo) throw new Error("Model " + selection.model + " is unavailable for provider " + selection.providerId + ".");

      const supported = modelInfo.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
      const provider = catalog.providers.find((candidate) => candidate.id === selection.providerId);
      const serviceTier = selection.serviceTier && provider?.serviceTiers?.some((tier) => tier.id === selection.serviceTier)
        ? selection.serviceTier
        : undefined;
      const stored: ModelSelection = {
        providerId: selection.providerId,
        model: modelInfo.model,
        reasoningLevel: supported.length > 0 && !supported.includes(selection.reasoningLevel)
          ? modelInfo.defaultReasoningEffort
          : selection.reasoningLevel,
        ...(serviceTier ? { serviceTier } : {}),
      };
      await bb.storage.kv.set(MODEL_SELECTION_KEY, stored);
      modelSelection = stored;
      publishChanged({ settings: true });
      return { selection: stored };
    },
    recap_settings_get: async () => config,
    recap_settings_set: async (next) => {
      const stored = {
        ...next,
        prompt: normalizeRecapPrompt(next.prompt),
      };
      await persistSettings(stored);
      return stored;
    },
    recap_display_mode_set: async ({ displayMode }) => {
      await persistSettings({ ...config, displayMode });
      return { displayMode };
    },
    recap_generate: async ({ threadId, automatic }) => {
      const isAutomatic = automatic === true;
      const generation = await beginGeneration(threadId, isAutomatic);
      if (!isAutomatic) await rearmAfterManual(threadId, generation);
      if (!isAutomatic && generation.reason === "thread_not_idle") {
        throw new Error("Wait for the thread to become idle before generating a recap.");
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
  const cliError = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}` });

  bb.cli.register({
    name: "recap",
    summary: "Generate and review concise recaps of BB threads",
    commands: [
      { name: "recap", summary: "Generate a recap", usage: "bb recap recap [thread-id] [--json]" },
      { name: "summarize", summary: "Alias for recap", usage: "bb recap summarize [thread-id] [--json]" },
      { name: "show", summary: "Show the latest recap", usage: "bb recap show [thread-id] [--json]" },
      { name: "list", summary: "List generated recaps", usage: "bb recap list [--limit N] [--json]" },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const command = args.shift();
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };

      if (command === "list") {
        let limit = 50;
        if (args.length === 2 && args[0] === "--limit") {
          const parsed = parsePositiveInteger(args[1]);
          if (parsed === null) return cliError("--limit must be a positive integer.");
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
              : recaps.map((recap) => `[${new Date(recap.generatedAt).toISOString()}] ${recap.threadId}  ${recap.summary}`).join("\n"),
        };
      }

      if (!["recap", "summarize", "show"].includes(command) || args.length > 1) return cliError("Unknown arguments.");
      const threadId = args[0] ?? context.threadId;
      if (!threadId) return cliError("A thread id is required outside a thread-aware CLI context.");

      if (command === "show") {
        const recap = latestRecap(threadId);
        if (!recap) return { exitCode: 1, stderr: `No recap for thread ${threadId}.` };
        return { exitCode: 0, stdout: json ? JSON.stringify(recap) : recap.summary };
      }

      const generation = await beginGeneration(threadId, false, undefined, context.signal);
      await rearmAfterManual(threadId, generation, context.signal);
      if (!generation.recap) {
        return { exitCode: 1, stderr: generation.reason === "thread_not_idle"
          ? "Wait for the thread to become idle before generating a recap."
          : `Could not generate a recap (${generation.reason ?? "unknown error"}).` };
      }
      return { exitCode: 0, stdout: json ? JSON.stringify(generation.recap) : generation.recap.summary };
    },
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (!isRecapEventTarget(thread, bb.pluginId)) return;
    invalidateRecap(thread.id);
    const state = states.get(thread.id);
    if (state) {
      state.generationController?.abort();
      state.epoch += 1;
      state.idleThread = undefined;
      clearTimer(state);
      if (!state.inFlight) states.delete(thread.id);
    }
  });

  bb.events.on("thread.idle", ({ thread }) => {
    if (!isRecapEventTarget(thread, bb.pluginId)) return;
    scheduleAutomaticRecap(thread);
  });

  bb.events.on("thread.failed", ({ thread }) => {
    const state = states.get(thread.id);
    if (!state) return;
    state.generationController?.abort();
    state.epoch += 1;
    state.idleThread = undefined;
    clearTimer(state);
  });

  const removeThreadState = ({ thread }: { thread: ThreadSnapshot }) => {
    const state = states.get(thread.id);
    if (!state) return;
    state.retired = true;
    state.generationController?.abort();
    clearTimer(state);
    state.idleThread = undefined;
    if (!state.inFlight) states.delete(thread.id);
  };
  bb.events.on("thread.archived", removeThreadState);
  bb.events.on("thread.deleted", removeThreadState);

  bb.onDispose(async () => {
    disposed = true;
    bootstrapController.abort();
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
  void bootstrapIdleThreads(bootstrapController.signal);
}
