import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as recapHelpers from "../src/recap.ts";

// Exercise the production hook's async RPC flow without requiring a BB host or DOM.
// Hook stubs keep state between renders and expose the realtime subscription.
function mountRecapHook(call: (method: string) => Promise<unknown>) {
  const source = readFileSync(new URL("../src/app.tsx", import.meta.url), "utf8");
  const hook = source.slice(source.indexOf("function useThreadRecap"), source.indexOf("\nfunction RecapPanel"));
  const messageStart = source.indexOf("function generationErrorMessage");
  const messages = messageStart < 0 ? "" : source.slice(messageStart, source.indexOf("\nfunction isRecord", messageStart));
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const threadIdBox = { id: "t1" };
  let index = 0;
  let refIndex = 0;
  let realtime: (payload: unknown) => void = () => {};
  const rpc = { call };
  const environment = {
    ...recapHelpers,
    threadIdBox,
    useRpc: () => rpc,
    useState: (initial: unknown) => {
      const slot = index++;
      if (!(slot in states)) states[slot] = initial;
      return [states[slot], (value: unknown) => { states[slot] = value; }];
    },
    useRef: (initial: unknown) => {
      const slot = refIndex++;
      if (!refs[slot]) refs[slot] = { current: initial };
      return refs[slot];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useRealtime: (_event: string, callback: typeof realtime) => { realtime = callback; },
    isRecord: (value: unknown) => value !== null && typeof value === "object",
    RECAP_CHANGED: "recap-changed",
  };
  const compiled = ts.transpileModule(`${messages}\n${hook}\nreturn useThreadRecap(threadIdBox.id);`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const run = new Function(...Object.keys(environment), compiled) as (...args: unknown[]) => {
    generate: () => Promise<void>;
    error: string | null;
    recap: { id?: string; summary?: string } | null;
    generating: boolean;
  };
  return {
    render: () => { index = 0; refIndex = 0; return run(...Object.values(environment)); },
    signal: () => realtime({ threadId: threadIdBox.id }),
    setThreadId: (id: string) => { threadIdBox.id = id; },
  };
}

for (const failure of ["empty_model_response", "provider failure"]) {
  test(`keeps generation failure visible after successful reads: ${failure}`, async () => {
    let fail = true;
    const hook = mountRecapHook(async (method) => {
      if (method === "recap_get") return { recap: null, generating: false };
      if (fail && failure === "provider failure") throw new Error(failure);
      return fail ? { recap: null, reason: failure } : { recap: { summary: "Done" }, reason: null };
    });
    await hook.render().generate();
    await Promise.resolve();
    const error = hook.render().error;
    assert.equal(error, failure === "provider failure" ? failure : "The recap model returned no usable summary.");
    hook.signal();
    await Promise.resolve();
    assert.equal(hook.render().error, error);
    fail = false;
    await hook.render().generate();
    await Promise.resolve();
    assert.equal(hook.render().error, null);
  });
}

test("hides the previous thread's recap as soon as the thread changes", async () => {
  const hook = mountRecapHook(async (method) => {
    if (method === "recap_get") return { recap: { id: "got", summary: "Loaded" }, generating: false };
    return { recap: { id: "made", summary: "Made" }, reason: null };
  });
  await hook.render().generate();
  const before = hook.render().recap;
  assert.ok(before?.summary === "Made" || before?.summary === "Loaded");
  hook.setThreadId("t2");
  const switched = hook.render();
  assert.equal(switched.recap, null);
  assert.equal(switched.generating, false);
  assert.equal(switched.error, null);
});

test("shows a generation failure on the thread that requested it", async () => {
  let fail = false;
  const hook = mountRecapHook(async () => {
    if (fail) throw new Error("offline");
    return { recap: { id: "a", summary: "Alpha" }, generating: false, reason: null };
  });
  await hook.render().generate();
  hook.setThreadId("t2");
  fail = true;
  await hook.render().generate();
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.error, "offline");
  assert.equal(view.recap, null);
  assert.equal(view.generating, false);
});

test("keeps a generation failure when a refresh arrives while it is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hook = mountRecapHook(async (method) => {
    if (method === "recap_generate") {
      await gate;
      throw new Error("provider failure");
    }
    return { recap: { id: "old", summary: "Old" }, generating: false };
  });
  const pending = hook.render().generate();
  hook.signal();
  await Promise.resolve();
  release();
  await pending;
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.error, "provider failure");
  assert.equal(view.recap?.summary, "Old");
});

test("a failed refresh keeps the recap already on screen", async () => {
  let failGet = false;
  const hook = mountRecapHook(async (method) => {
    if (method === "recap_get" && failGet) throw new Error("offline");
    return { recap: { id: "a", summary: "Alpha" }, generating: false, reason: null };
  });
  await hook.render().generate();
  await Promise.resolve();
  failGet = true;
  hook.signal();
  await Promise.resolve();
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.recap?.summary, "Alpha");
  assert.equal(view.error, "offline");
});

test("a null generation result keeps the recap already on screen", async () => {
  let fail = false;
  const hook = mountRecapHook(async (method) => {
    if (fail && method === "recap_generate") return { recap: null, reason: "empty_model_response" };
    return { recap: { id: "a", summary: "Alpha" }, generating: false, reason: null };
  });
  await hook.render().generate();
  await Promise.resolve();
  fail = true;
  await hook.render().generate();
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.recap?.summary, "Alpha");
  assert.equal(view.recap?.id, "a");
  assert.equal(view.error, "The recap model returned no usable summary.");
});

test("a null generation result keeps the recap when the follow-up read fails", async () => {
  let fail = false;
  const hook = mountRecapHook(async (method) => {
    if (fail && method === "recap_get") throw new Error("offline");
    if (fail && method === "recap_generate") return { recap: null, reason: "empty_model_response" };
    return { recap: { id: "a", summary: "Alpha" }, generating: false, reason: null };
  });
  await hook.render().generate();
  await Promise.resolve();
  fail = true;
  await hook.render().generate();
  await Promise.resolve();
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.recap?.summary, "Alpha");
  assert.equal(view.error, "The recap model returned no usable summary.");
});

test("a null generation result drops the recap after a read confirms it is gone", async () => {
  let fail = false;
  const hook = mountRecapHook(async (method) => {
    if (fail && method === "recap_generate") return { recap: null, reason: "stale" };
    if (fail) return { recap: null, generating: false };
    return { recap: { id: "a", summary: "Alpha" }, generating: false, reason: null };
  });
  await hook.render().generate();
  await Promise.resolve();
  fail = true;
  await hook.render().generate();
  await Promise.resolve();
  await Promise.resolve();
  const view = hook.render();
  assert.equal(view.recap, null);
  assert.equal(view.error, "The thread changed while the recap was generating. Try again.");
});
