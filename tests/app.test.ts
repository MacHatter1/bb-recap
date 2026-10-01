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
  let index = 0;
  let realtime: (payload: unknown) => void = () => {};
  const rpc = { call };
  const environment = {
    ...recapHelpers,
    useRpc: () => rpc,
    useState: (initial: unknown) => {
      const slot = index++;
      if (!(slot in states)) states[slot] = initial;
      return [states[slot], (value: unknown) => { states[slot] = value; }];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useRealtime: (_event: string, callback: typeof realtime) => { realtime = callback; },
    isRecord: (value: unknown) => value !== null && typeof value === "object",
    RECAP_CHANGED: "recap-changed",
  };
  const compiled = ts.transpileModule(`${messages}\n${hook}\nreturn useThreadRecap('t1');`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const run = new Function(...Object.keys(environment), compiled) as (...args: unknown[]) => { generate: () => Promise<void>; error: string | null };
  return {
    render: () => { index = 0; return run(...Object.values(environment)); },
    signal: () => realtime({ threadId: "t1" }),
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
