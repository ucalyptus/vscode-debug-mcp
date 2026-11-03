# Instructions for an AI agent using vscode-debug-mcp

You control a **live desktop VSCode debugger** over MCP. You call tools; you do
not click or send keystrokes. Everything here matters because restart has
specific semantics you must respect to avoid re-launching processes instead of
restarting them.

## 0. You are usable only if

- the `vscode-debug-mcp-ctl` extension is installed **and** a VSCode window is
  open on the machine I (the server) reach via `http://127.0.0.1:8787` (see
  DEBUGCTL_URL / DEBUGCTL_TOKEN), and
- the debugger is running a session. If you get a "Cannot reach VSCode" /
  connection error, the extension window is closed or port is wrong — that's
  an environment problem, not something a retry fixes.

## 1. The model you must hold (one-sentence version)

A VSCode debugger has **sessions**; exactly one is **focused/active** at a
time; `debug_restart` restarts **only the focused session** — same as the
toolbar Restart button; `debug_start` always creates a **brand-new** session
(a second, disjoint process set) — that is the Play behavior you must NOT use
when the user means "restart".

### UI button -> tool map (so you know what you're reproducing)

| UI | Tool | What it does |
|---|---|---|
| Restart button (Call Stack pane, top of stack) | `debug_restart` | Restarts focused session **in place** (same session id). |
| Play / F5 | `debug_start` | New session, new process(es). Use only to *start* fresh. |
| Stop | `debug_stop` | Terminate session. |
| Continue / Pause | `debug_run_command` `workbench.action.debug.continue` / `.pause` | Adjacent control. |
| (any DAP request) | `debug_custom_request` | e.g. `continue`, `evaluate`; `restart` only if adapter supports it. |

## 2. Decision logic for restart

1. Call `debug_list_sessions` first. It returns `{ active, sessions: [...] }`.
2. If `active` is `null` → **nothing is running**; `debug_restart` fails. Tell
   the user there is no live session (or offer `debug_start`).
3. To restart: call `debug_restart` **without** `sessionId` (defaults to the
   focused one), or **with** `sessionId === active`. Passing any other id fails
   with guidance — that's intentional and matches VSCode itself.
4. `session.isChild === true` means the session belongs to a compound /
   parent-managed group; restarting the parent handles children.

## 3. What actually happens (so you can predict outcomes)

`debug_restart` → `workbench.action.debug.restart` → `restartSession(focused)`:

- If the debug adapter declares `supportsRestartRequest` → a DAP `restart`
  request is sent; the adapter relaunches **in place**. Fast, same process
  identity.
- Otherwise (most adapters, e.g. `debugpy`, many node/cpp configs) → the
  session is terminated, **launch.json is re-read and re-resolved**, and after
  a 300ms delay the session is relaunched/reattached **with the same session
  id**. A new OS process does spawn, but it is the same *debugger* session —
  breakpoints, watch, variables, call-stack view survive. This is "restart",
  distinct from `debug_start` which is a separate session and process set.
- `preLaunchTask` / `postDebugTask` / `preRestartTask` / `postRestartTask` run
  on a manual restart (skipped for automatic restarts). A failing task aborts
  the restart — surface that error to the user.

## 4. Required state the user must have

- A launch configuration in `launch.json` (or an attach config already
  running), else `debug_start` / `debug_restart` resolve nothing.
- For attach-only targets: auto-restart comes from `"restart": true` in the
  attach config; otherwise restart re-runs the adapter and reconnects.

## 5. Failure handling (never silently retry)

| Symptom | Cause | Action |
|---|---|---|
| `No active debug session` | Not running | Offer `debug_start`; don't claim to restart. |
| `not the focused session` | Passed wrong sessionId | Report; use stop+start or ask user to focus it. (No public API to focus a specific session.) |
| HTTP connect error | Extension/window closed | Environment issue; no retry. |
| `isError` from a tool | Adapter/task refused | Return the message verbatim. |

## 6. Golden rule

When the user says "restart the process(es) under the debugger" → almost
always **`debug_restart`** on the focused session. Reach for `debug_stop`
+ `debug_start` only when the restart target is genuinely a *different*
session than the focused one, and say so explicitly, because that path does
NOT preserve the session (it is closest to Play, not to Restart).