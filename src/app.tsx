import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalProviderModelPickerValue,
  PluginSettingsSectionProps,
  PluginThreadHeaderActionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_RECAP_PROMPT,
  isBlankRecapPrompt,
  MAX_CONCURRENT_GENERATIONS,
  MAX_RECAP_PROMPT_CHARS,
  MIN_CONCURRENT_GENERATIONS,
  normalizeRecapSettings,
  parseClampedInteger,
  RECAP_DISPLAY_MODE_OPTIONS,
  RECAP_DISPLAY_MODES,
  recapFormIsDirty,
  settingsFormStatus,
  settingsFormStatusLabel,
  shouldShowRecapBanner,
} from "./recap";
import type { RecapDisplayMode } from "./recap";
import type { ModelSelection, Recap, RecapSettings, rpcContract } from "./server";

const RECAP_CHANGED = "recap-changed";

function generationErrorMessage(reason: string | null): string {
  switch (reason) {
    case "no_conversation":
      return "There is no conversation to recap yet.";
    case "not_enough_turns":
      return "There are not enough user turns for an automatic recap yet.";
    case "already_exists":
      return "A recap already exists for this conversation state.";
    case "already_generating":
      return "A recap is already being generated.";
    case "stale":
      return "The thread changed while the recap was generating. Try again.";
    case "aborted":
      return "Recap generation was cancelled.";
    case "empty_model_response":
      return "The recap model returned no usable summary.";
    case "suppressed":
      return "This recap was suppressed because the model response was too long.";
    default:
      return reason ? `Could not generate a recap (${reason}).` : "No recap was generated.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkboxFromInput(
  event: { currentTarget: EventTarget | null; target: EventTarget },
): boolean {
  const element = event.currentTarget instanceof HTMLInputElement
    ? event.currentTarget
    : event.target instanceof HTMLInputElement
      ? event.target
      : null;
  return element?.checked ?? false;
}

function textFromInput(
  event: { currentTarget: EventTarget | null; target: EventTarget },
): string {
  const element = event.currentTarget instanceof HTMLTextAreaElement || event.currentTarget instanceof HTMLInputElement
    ? event.currentTarget
    : event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
      ? event.target
      : null;
  return element?.value ?? "";
}

function useRecapSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<RecapSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const applySettings = useCallback((value: unknown) => {
    setSettings(normalizeRecapSettings(value));
  }, []);

  const reload = useCallback(async (background = false) => {
    if (!background) setIsLoading(true);
    try {
      applySettings(await rpcRef.current.call("recap_settings_get", {}));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!background) setIsLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void reload(false);
  }, [reload]);
  const onSettingsSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.settings === true) void reload(true);
  }, [reload]);
  useRealtime(RECAP_CHANGED, onSettingsSignal);

  return { settings, setSettings, isLoading, error };
}

function useThreadRecap(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await rpc.call("recap_get", { threadId });
      setRecap(next.recap);
      setGenerating(next.generating);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.threadId === threadId) void reload();
  }, [reload, threadId]);
  useRealtime(RECAP_CHANGED, onSignal);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const next = await rpc.call("recap_generate", { threadId, automatic: false });
      setRecap(next.recap);
      if (!next.recap && next.reason !== "suppressed") setError(generationErrorMessage(next.reason));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGenerating(false);
      void reload();
    }
  }, [reload, rpc, threadId]);

  return { recap, generating, loading, error, generate };
}

function RecapPanel({ threadId, params }: PluginThreadPanelProps) {
  const { recap, generating, loading, error, generate } = useThreadRecap(threadId);
  const requested = isRecord(params) && params.generate === true;
  const requestedAt =
    isRecord(params) &&
    typeof params.requestedAt === "number" &&
    Number.isFinite(params.requestedAt)
      ? params.requestedAt
      : null;
  const requestedKey = requested ? `${threadId}:${requestedAt ?? "legacy"}` : null;
  const requestedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!requested || requestedKey === null) {
      requestedRef.current = null;
      return;
    }
    const needsGeneration =
      recap === null ||
      (requestedAt !== null && recap.generatedAt < requestedAt);
    if (
      requestedRef.current !== requestedKey &&
      !loading &&
      needsGeneration &&
      !generating
    ) {
      requestedRef.current = requestedKey;
      void generate();
    }
  }, [generate, generating, loading, recap, requested, requestedAt, requestedKey]);

  return (
    <div className="space-y-4 p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Latest recap</p>
          <p className="text-xs text-muted-foreground">Stored separately from the thread transcript.</p>
        </div>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void generate()}
          disabled={loading || generating}
        >
          {loading ? "Loading…" : generating ? "Generating…" : "Generate"}
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {recap ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm leading-6 text-foreground">{recap.summary}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {recap.automatic ? "Automatic" : "Manual"} · {recap.model} · {new Date(recap.generatedAt).toLocaleString()}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No recap has been generated for this thread yet.
        </div>
      )}
    </div>
  );
}

function RecapComposerBannerContent({
  threadId,
  mode,
}: {
  threadId: string;
  mode: RecapDisplayMode;
}) {
  const { recap, generating, loading, error, generate } = useThreadRecap(threadId);
  const compact = mode === RECAP_DISPLAY_MODES.compact;
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [mode, recap?.id, recap?.summary, threadId]);

  if (!recap) {
    if (!generating) return null;
    return (
      <div
        className={compact
          ? "mx-auto mb-2 flex w-full min-w-0 max-w-3xl items-center gap-2 rounded-lg border border-border bg-surface-recessed/20 px-3 py-2.5 shadow-sm"
          : "mx-auto mb-3 w-full min-w-0 max-w-3xl rounded-xl border border-border border-l-2 border-l-foreground bg-card p-4 shadow-sm sm:p-5"}
        role="status"
        aria-live="polite"
        aria-label="Generating recap"
      >
        <p className="text-sm text-muted-foreground">Generating recap…</p>
      </div>
    );
  }

  if (compact) {
    const compactSummary = (
      <>
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-sm text-foreground">
          ✦
        </span>
        <div aria-live="polite" className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-foreground">Recap</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {recap.automatic ? "Automatic" : "Manual"} · {new Date(recap.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          <p className={expanded ? "text-sm leading-5 text-foreground" : "truncate text-sm leading-5 text-foreground"} title={recap.summary}>
            {recap.summary}
          </p>
          {expanded ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {recap.model} · {new Date(recap.generatedAt).toLocaleString()}
            </p>
          ) : null}
          {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
        </div>
        <span className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground transition-colors group-hover:border-border group-hover:bg-background group-hover:text-foreground">
          {expanded ? "Collapse" : "Expand"}
          <span aria-hidden="true" className="text-sm leading-none">{expanded ? "↓" : "↑"}</span>
        </span>
      </>
    );

    return (
      <div
        className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl items-center gap-2 rounded-lg border border-border bg-surface-recessed/20 px-3 py-2.5 shadow-sm"
        role="region"
        aria-label="Latest recap"
      >
        <button
          type="button"
          className="group flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg p-1 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={expanded ? "Collapse recap" : "Expand recap"}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {compactSummary}
        </button>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          onClick={() => void generate()}
          disabled={loading || generating}
        >
          {loading ? "Loading…" : generating ? "Generating…" : "Refresh"}
        </button>
      </div>
    );
  }

  return (
    <div
      className="mx-auto mb-3 w-full min-w-0 max-w-3xl rounded-xl border border-border border-l-2 border-l-foreground bg-card p-4 shadow-sm sm:p-5"
      role="region"
      aria-label="Latest recap"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-base text-foreground">
            ✦
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Latest recap</p>
            <p className="truncate text-xs text-muted-foreground">
              Updated {new Date(recap.generatedAt).toLocaleString()}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {recap.automatic ? "Automatic" : "Manual"}
        </span>
      </div>
      <div aria-live="polite" className="mt-4">
        <p className="text-base leading-7 text-foreground" title={recap.summary}>
          {recap.summary}
        </p>
        {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground" title={recap.model}>
          Generated with {recap.model}
        </p>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          onClick={() => void generate()}
          disabled={loading || generating}
        >
          {loading ? "Loading…" : generating ? "Generating…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
function RecapComposerBanner() {
  const { scope } = useComposerView();
  const { settings, isLoading } = useRecapSettings();
  const bannerRef = useRef<HTMLDivElement>(null);
  const [isInlineMessageEditor, setIsInlineMessageEditor] = useState(false);

  // ponytail: BB DOM-marker fallback; switch to ComposerView edit state when the host exposes it.
  useLayoutEffect(() => {
    const next = Boolean(bannerRef.current?.closest("[data-inline-message-editor-frame]"));
    setIsInlineMessageEditor((current) => current === next ? current : next);
  }, [isInlineMessageEditor, scope.kind]);

  if (scope.kind !== "thread") return null;
  const showBanner = shouldShowRecapBanner(scope.kind, isInlineMessageEditor);
  const content =
    !isLoading && settings && showBanner && settings.displayMode !== RECAP_DISPLAY_MODES.onDemand
      ? <RecapComposerBannerContent threadId={scope.threadId} mode={settings.displayMode} />
      : null;
  return (
    <div ref={bannerRef} className="contents">
      {content}
    </div>
  );
}

function DisplayModePreview({
  mode,
  selected,
  disabled,
  onSelect,
}: {
  mode: RecapDisplayMode;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: RecapDisplayMode) => void;
}) {
  return (
    <button
      type="button"
      className={selected
        ? "w-full rounded-lg border border-foreground bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        : "w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onSelect(mode)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{mode}</p>
        <span className="text-xs text-muted-foreground">{selected ? "Current" : "Preview"}</span>
      </div>
      <div className="mt-3 rounded-md bg-background p-2" aria-hidden="true">
        {mode === RECAP_DISPLAY_MODES.compact ? (
          <div className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-surface-recessed/20 px-2">
            <div className="h-6 w-6 shrink-0 rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-1.5 w-12 rounded-full bg-muted" />
              <div className="h-2 w-4/5 rounded-full bg-muted" />
            </div>
            <div className="flex shrink-0 gap-1">
              <div className="h-6 w-12 rounded border border-border bg-muted" />
              <div className="h-6 w-14 rounded border border-border bg-muted" />
            </div>
          </div>
        ) : mode === RECAP_DISPLAY_MODES.card ? (
          <div className="space-y-3 rounded-xl border border-border border-l-2 border-l-muted bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="h-7 w-7 shrink-0 rounded-lg bg-muted" />
                <div className="space-y-1.5">
                  <div className="h-1.5 w-20 rounded-full bg-muted" />
                  <div className="h-1.5 w-24 rounded-full bg-muted" />
                </div>
              </div>
              <div className="h-5 w-14 shrink-0 rounded-full bg-muted" />
            </div>
            <div className="space-y-1.5">
              <div className="h-2 w-full rounded-full bg-muted" />
              <div className="h-2 w-4/5 rounded-full bg-muted" />
              <div className="h-2 w-1/2 rounded-full bg-muted" />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-2">
              <div className="h-1.5 w-28 rounded-full bg-muted" />
              <div className="h-6 w-14 rounded border border-border bg-muted" />
            </div>
          </div>
        ) : (
          <div className="flex min-h-10 items-center justify-center rounded-md border border-dashed border-border bg-surface-recessed/10 px-2">
            <span className="text-xs text-muted-foreground">No inline recap</span>
          </div>
        )}
      </div>
    </button>
  );
}

function pickerValueFromSelection(selection: ModelSelection | null): ExperimentalProviderModelPickerValue | null {
  if (
    !selection ||
    typeof selection.providerId !== "string" ||
    typeof selection.model !== "string" ||
    typeof selection.reasoningLevel !== "string"
  ) {
    return null;
  }
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  };
}

function BoundedNumberInput({
  value,
  min,
  max,
  fallback,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  fallback: number;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const display = text ?? String(value);

  const handleChange = (event: { currentTarget: EventTarget | null; target: EventTarget }) => {
    const raw = textFromInput(event);
    setText(raw);
    if (/^-?\d+$/.test(raw.trim())) {
      onCommit(parseClampedInteger(raw, fallback, min, max));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      disabled={disabled}
      onChange={handleChange}
      onBlur={() => setText(null)}
      className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

function SettingsSection(_props: PluginSettingsSectionProps) {
  return <SettingsSectionBody />;
}

function SettingsSectionBody() {
  const rpc = useRpc<typeof rpcContract>();
  const {
    settings,
    setSettings: setLoadedSettings,
    isLoading: settingsLoading,
    error: settingsLoadError,
  } = useRecapSettings();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [configured, setConfigured] = useState(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState<RecapSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [displayModeSaving, setDisplayModeSaving] = useState(false);
  const [displayModeError, setDisplayModeError] = useState<string | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const loadModel = useCallback(async (background = false) => {
    if (!background) setModelLoading(true);
    try {
      const next = await rpcRef.current.call("recap_model_get", {});
      setSelection(next.selection);
      setConfigured(next.configured);
      setModelError(null);
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!background) setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModel(false);
  }, [loadModel]);
  const onModelSettingsSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.settings === true) void loadModel(true);
  }, [loadModel]);
  useRealtime(RECAP_CHANGED, onModelSettingsSignal);

  const draft = settings
    ? { ...(localDraft ?? settings), displayMode: settings.displayMode }
    : null;
  const settingsDirty = localDraft !== null && settings !== null && recapFormIsDirty(localDraft, settings);

  const onModelChange = useCallback((next: ExperimentalProviderModelPickerValue) => {
    const nextSelection: ModelSelection = {
      providerId: next.providerId,
      model: next.model,
      reasoningLevel: next.reasoningLevel,
      ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}),
    };
    setSelection(nextSelection);
    setModelSaving(true);
    setModelError(null);
    void rpc.call("recap_model_set", nextSelection)
      .then((result) => {
        setSelection(result.selection);
        setConfigured(true);
      })
      .catch((cause) => {
        setModelError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setModelSaving(false));
  }, [rpc]);

  const updateDraft = useCallback((update: (current: RecapSettings) => RecapSettings) => {
    if (!settings) return;
    setLocalDraft((current) => {
      const next = update(current ?? settings);
      return recapFormIsDirty(next, settings) ? next : null;
    });
    setSettingsError(null);
  }, [settings]);

  const onDisplayModeSelect = useCallback((displayMode: RecapDisplayMode) => {
    if (settings?.displayMode === displayMode || displayModeSaving) return;
    const previous = settings?.displayMode;
    setDisplayModeError(null);
    setDisplayModeSaving(true);
    void rpc.call("recap_display_mode_set", { displayMode })
      .then((saved) => {
        setLoadedSettings((current) => current ? { ...current, displayMode: saved.displayMode } : current);
      })
      .catch((cause) => {
        if (previous) {
          setLoadedSettings((current) => current ? { ...current, displayMode: previous } : current);
        }
        setDisplayModeError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setDisplayModeSaving(false));
  }, [displayModeSaving, rpc, setLoadedSettings, settings?.displayMode]);

  const pickerValue = pickerValueFromSelection(selection);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Choose the recap model with BB's native provider/model picker. With no saved choice, recaps use BB's primary default model.
      </p>
      {modelLoading ? (
        <p className="text-xs text-muted-foreground">Loading BB models…</p>
      ) : pickerValue ? (
        <ProviderModelPicker
          value={pickerValue}
          onChange={onModelChange}
          align="start"
          className="w-full"
          disabled={modelSaving}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">BB's model catalog is unavailable.</p>
      )}
      {modelError ? <p role="alert" className="text-sm text-destructive">{modelError}</p> : null}
      {selection ? (
        <p className="text-xs text-muted-foreground">
          {configured ? "Saved selection" : "BB primary default"} · {selection.providerId}/{selection.model} · {selection.reasoningLevel} reasoning
          {selection.serviceTier ? " · " + selection.serviceTier + " service tier" : ""}
        </p>
      ) : null}
      {settingsLoadError ? <p role="alert" className="text-sm text-destructive">{settingsLoadError}</p> : null}
      {settingsLoading || !draft ? (
        <p className="text-xs text-muted-foreground">Loading recap settings…</p>
      ) : (
        <>
        <form
          className="space-y-5 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            const promptBlank = isBlankRecapPrompt(draft.prompt);
            if (!settingsDirty || settingsSaving || promptBlank) return;
            setSettingsSaving(true);
            setSettingsError(null);
            void rpc.call("recap_settings_set", draft)
              .then((saved) => {
                setLoadedSettings(normalizeRecapSettings(saved));
                setLocalDraft(null);
              })
              .catch((cause) => {
                setSettingsError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => setSettingsSaving(false));
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">Automatic recaps</p>
              <p className="text-xs text-muted-foreground">Generate a recap after the thread has been idle.</p>
            </div>
            <input
              type="checkbox"
              aria-label="Automatic recaps"
              checked={draft.auto}
              onChange={(event) => {
                const auto = checkboxFromInput(event);
                updateDraft((current) => ({ ...current, auto }));
              }}
              className="mt-0.5 h-4 w-4 accent-foreground"
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">Auto-clean up recaps</p>
              <p className="text-xs text-muted-foreground">Keep only the newest 1,000 visible recaps.</p>
            </div>
            <input
              type="checkbox"
              aria-label="Auto-clean up recaps"
              checked={draft.autoCleanup}
              onChange={(event) => {
                const autoCleanup = checkboxFromInput(event);
                updateDraft((current) => ({ ...current, autoCleanup }));
              }}
              className="mt-0.5 h-4 w-4 accent-foreground"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Idle delay (seconds)</span>
              <BoundedNumberInput
                value={draft.afterSeconds}
                min={0}
                max={86_400}
                fallback={0}
                disabled={settingsSaving}
                onCommit={(afterSeconds) => updateDraft((current) => ({ ...current, afterSeconds }))}
              />
              <span className="block text-xs text-muted-foreground">Wait this long after activity stops.</span>
            </label>
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Minimum user turns</span>
              <BoundedNumberInput
                value={draft.minTurns}
                min={1}
                max={100}
                fallback={1}
                disabled={settingsSaving}
                onCommit={(minTurns) => updateDraft((current) => ({ ...current, minTurns }))}
              />
              <span className="block text-xs text-muted-foreground">Start automatically at this many user turns.</span>
            </label>
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Max concurrent recaps</span>
              <BoundedNumberInput
                value={draft.maxConcurrent}
                min={MIN_CONCURRENT_GENERATIONS}
                max={MAX_CONCURRENT_GENERATIONS}
                fallback={MIN_CONCURRENT_GENERATIONS}
                disabled={settingsSaving}
                onCommit={(maxConcurrent) => updateDraft((current) => ({ ...current, maxConcurrent }))}
              />
              <span className="block text-xs text-muted-foreground">How many recap workers may run at once.</span>
            </label>
          </div>
          <label className="space-y-1.5">
            <span className="block font-medium text-foreground">Recap prompt</span>
            <span className="block text-xs text-muted-foreground">Instructions sent to the recap model.</span>
            <div className="relative">
              <textarea
                value={draft.prompt}
                rows={6}
                maxLength={MAX_RECAP_PROMPT_CHARS}
                spellCheck={false}
                aria-describedby="recap-prompt-count"
                onChange={(event) => {
                  const prompt = textFromInput(event);
                  updateDraft((current) => ({ ...current, prompt }));
                }}
                className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 pb-8 text-sm leading-5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p
                id="recap-prompt-count"
                className={MAX_RECAP_PROMPT_CHARS - draft.prompt.length < 200
                  ? "pointer-events-none absolute bottom-2 right-2 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] tabular-nums text-destructive"
                  : "pointer-events-none absolute bottom-2 right-2 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"}
              >
                {draft.prompt.length.toLocaleString()} / {MAX_RECAP_PROMPT_CHARS.toLocaleString()}
                {" · "}
                {(MAX_RECAP_PROMPT_CHARS - draft.prompt.length).toLocaleString()} left
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => updateDraft((current) => ({ ...current, prompt: DEFAULT_RECAP_PROMPT }))}
                disabled={draft.prompt === DEFAULT_RECAP_PROMPT || settingsSaving}
              >
                Reset to default
              </button>
            </div>
            {isBlankRecapPrompt(draft.prompt) ? (
              <p role="alert" className="text-sm text-destructive">
                Prompt cannot be empty. Save is disabled so the default is not restored silently. Use Reset to default if you want the built-in instructions.
              </p>
            ) : null}
          </label>
          {settingsError ? <p role="alert" className="text-sm text-destructive">{settingsError}</p> : null}
          <div className="flex items-center justify-between gap-3 pt-8">
            <p role="status" className="text-xs text-muted-foreground">
              {settingsFormStatusLabel(settingsFormStatus(settingsSaving, settingsDirty))}
            </p>
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!settingsDirty || settingsSaving || isBlankRecapPrompt(draft.prompt)}
            >
              Save settings
            </button>
          </div>
        </form>
        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <p className="font-medium text-foreground">Display previews</p>
            <p className="text-xs text-muted-foreground">
              Click a preview to apply that layout now. Other settings still need Save.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {RECAP_DISPLAY_MODE_OPTIONS.map((mode) => (
              <DisplayModePreview
                key={mode}
                mode={mode}
                selected={draft.displayMode === mode}
                disabled={displayModeSaving}
                onSelect={onDisplayModeSelect}
              />
            ))}
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {displayModeSaving ? "Applying layout…" : "Layout saves separately from the form above."}
          </p>
          {displayModeError ? <p role="alert" className="text-sm text-destructive">{displayModeError}</p> : null}
        </div>
        </>
      )}
    </div>
  );
}

function RecapHeaderAction({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Generate Recap"
      onClick={() => navigate.openThreadPanel({
        actionId: "recap",
        title: "Recap",
        params: { generate: true, requestedAt: Date.now() },
      })}
    >
      {isCompactViewport ? "✦" : "Recap"}
    </button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "recap-banner",
    banners: [{ id: "recap", chrome: "bare", component: RecapComposerBanner }],
  });
  app.slots.settingsSection({
    id: "settings",
    title: "Recap behavior",
    description: "Choose the model, automatic behavior, cleanup, and display previews.",
    component: SettingsSection,
  });
  app.slots.threadPanelAction({
    id: "recap",
    title: "Recap",
    icon: "Zap",
    component: RecapPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "recap",
    title: "Recap",
    component: RecapHeaderAction,
  });
  app.slots.commandPaletteAction({
    id: "generate",
    title: "Recap: generate for this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel, threadId }) => {
      if (threadId === null) return;
      openPanel({ actionId: "recap", title: "Recap", params: { generate: true, requestedAt: Date.now() } });
    },
  });
});
