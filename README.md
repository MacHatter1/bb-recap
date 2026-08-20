# Grok-style recap for Pi

Adds `/recap` (and `/summarize`) to Pi. It produces a short, one-sentence “where was I?” summary using the currently selected model.

Unlike `sendMessage()`, the recap is stored as a display-only custom entry, so it appears in the transcript but is **not** fed back into the model context.

## Automatic recaps

When enabled, Pi generates a recap automatically 30 seconds after the agent settles, provided the session has at least three user turns. It does not wait for another user message. Pi does not currently expose desktop focus events, so the extension measures inactivity from the last settled turn. Sending a prompt cancels the pending timer and starts a fresh idle window after that turn settles.

Configure with environment variables before starting Pi:

```sh
PI_GROK_RECAP_AUTO=false pi
PI_GROK_RECAP_AFTER_SECONDS=90 pi
PI_GROK_RECAP_MIN_TURNS=3 pi
```

By default, recaps use Pi's currently selected model with low thinking. Configure them from inside Pi:

```text
/recap-setup
```

This opens a TUI that shows available models, thinking levels, automatic enablement, idle delay, and minimum turns. Choices are persisted in Pi's global recap settings. Older session settings are still read for compatibility, and all settings remain excluded from model context. If no choice is made, the existing active-model/low-thinking behavior is used. The model must already be configured in Pi's model registry.

The extension is installed globally at `~/.pi/agent/extensions/grok-recap/` and is auto-discovered by Pi. Restart Pi or run `/reload` after changing it.
