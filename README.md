# Recap for BB

Recap creates short, display-only summaries of BB threads. A recap is stored
separately from the thread transcript, so it is never added to the model's
conversation context.

## What it does

- Generate a recap from the thread header, command palette, or CLI.
- Generate recaps automatically after a thread has been idle.
- Refresh a recap whenever the thread has moved on.
- Keep the recap worker hidden and clean it up after each attempt.

Manual generation requires the thread to be idle. Automatic generation only
runs for visible BB threads and waits until the configured user-turn minimum.
Starting a new turn invalidates the previous in-thread recap until a newer one
is generated.

## In-thread display presets

Choose **Display previews** on the plugin settings page. Click any preview card
to save it:

- **Compact banner** — a quiet one-line recap above the composer. Click the
  recap to expand or collapse it when more detail is needed.
- **Recap card** — a larger card with timestamp, generation type, model, and a
  refresh action.
- **On demand** — keeps the composer clear; open the Recap panel when needed.

## Settings

The single **Recap behavior** card on the plugin settings page controls the
model, automatic behavior, cleanup, prompt, and display previews. These
settings are stored by Recap itself; use this card rather than `bb plugin config`.
The native BB provider/model picker uses BB's live model catalog and saves the
selected provider, model,
reasoning level, and service tier. Without a saved selection, recaps use BB's
current default model.

`afterSeconds` is capped at 86,400 seconds. `minTurns` accepts 1–100 user
turns. The prompt is capped at 8,000 characters. Auto-cleanup removes
suppressed attempts and keeps the newest 1,000 visible recaps; it is enabled by
default and runs when the plugin starts, when settings are saved, and after a
recap is generated. Settings changes apply immediately.

## CLI

```sh
bb recap recap [thread-id] [--json]
bb recap summarize [thread-id] [--json]
bb recap show [thread-id] [--json]
bb recap list [--limit N] [--json]
```

Leave out `thread-id` when running from a thread-aware BB CLI context. The
`summarize` command is an alias for `recap`.

## Data and safety

Recaps live in the plugin's namespaced SQLite database. When auto-cleanup is
enabled, only the latest 1,000 visible records are kept. The source transcript
is bounded and escaped before it is sent to the worker, and it is wrapped as
untrusted session data. Recap workers use BB's review-required permission mode
and are archived and stopped after each attempt. Generated text is normalized
and limited to 1,200 characters.

## Development

Requirements: BB 0.40 or newer and the BB plugin SDK 0.4.21 or newer.

```sh
npm install
npm test
npx tsc --noEmit
bb plugin types --check .
bb plugin build .
bb plugin reload bb-recap
```

The main files are:

- `server.ts` — settings, storage, RPC, CLI, scheduling, and thread events.
- `app.tsx` — BB thread, sidebar, command palette, and settings UI.
- `recap.ts` — bounded transcript and prompt helpers.
- `recap.test.ts` — tests for the pure recap helpers.
