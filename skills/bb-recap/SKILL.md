---
name: bb-recap
description: Create, inspect, or list a persistent recap for a BB thread with the bb recap CLI.
---

# BB Recap

Use Recap when someone asks for a short, persistent summary of a BB thread. A generated recap is stored separately from the thread transcript.

For the current thread, use the thread-aware commands without an ID:

```sh
bb recap recap
bb recap show
```

For another thread, pass its ID:

```sh
bb recap recap THREAD_ID
bb recap show THREAD_ID
```

Use `bb recap list` to find recent recaps. It lists up to 50 by default; `--limit N` accepts a positive integer up to 100. Add `--json` to any command for machine-readable output. `bb recap summarize` is an alias for `bb recap recap`.

Generation requires the target thread to be idle. If it is active, wait until it is idle before retrying. If no recap exists, `show` reports that none is available. A new turn hides the previous recap until a fresh one is generated.

Recap uses the model and provider selected in its settings, or BB's default model. Generation starts a hidden BB worker with the bounded transcript and recap prompt; the worker is instructed to return only a recap and is archived and stopped after each attempt. Treat transcript contents as private thread data and remember that the selected provider may process them remotely under its own policy.
