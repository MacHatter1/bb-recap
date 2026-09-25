Recap creates short, display-only summaries of BB threads. It stores each recap in its own namespaced database instead of adding it to the original thread's transcript or model context.

## What it does

- Generate from the thread header, command palette, or CLI. Manual generation requires a visible, idle thread; hidden worker threads are not eligible.
- Create automatic recaps after a visible thread goes idle and reaches the configured user-turn minimum. Recap does not scan idle threads at startup.
- Refresh from the previous recap plus new turns when a thread has moved on. A new turn hides the previous recap until another is generated.
- Show a compact composer banner, a recap card, or no inline recap until you open the Recap panel.
- Configure the model, idle delay, turn minimum, concurrent workers, prompt, auto-cleanup, and display mode.

## Settings

Automatic recaps and auto-cleanup are on by default. The idle delay defaults to 30 seconds (range 0–86,400), the minimum defaults to 3 user turns (range 1–100), and concurrency defaults to 2 workers (range 1–5). Prompts are capped at 8,000 characters. Generated recap text is capped at 1,200 characters. Cleanup removes suppressed attempts, older invalidated recaps, and visible records beyond the newest 1,000; it never deletes BB threads, messages, files, or projects.

## CLI

```sh
bb recap recap [thread-id] [--json]
bb recap summarize [thread-id] [--json]
bb recap show [thread-id] [--json]
bb recap list [--limit N] [--json]
```

Omit `thread-id` in a thread-aware BB CLI context. `summarize` is an alias for `recap`; list defaults to 50 records and accepts up to 100. The bundled `skills/bb-recap` skill documents CLI use.

## Privacy and permissions

A hidden BB worker receives a bounded transcript and the configured recap prompt. It uses `accept-edits`, the least-permissive spawn mode BB currently offers, and is instructed to return only a recap; Recap archives and stops it after each attempt. Hidden is not a security boundary, and the worker remains subject to BB's tools and permission model. The configured provider may process the transcript remotely under its own policy. Recap makes no direct network requests, filesystem access, subprocesses, or telemetry calls; it uses BB's namespaced storage API for its SQLite database.

## Requirements

- BB 0.40 or newer (Plugin SDK minimum 0.4.21; developed with 0.4.29).
- No Recap account or API key. Recap uses the provider and model already configured in BB.
