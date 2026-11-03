# vscode-debug-mcp

An agent-callable MCP server that restarts / starts / stops / pokes debug sessions in a **running desktop VSCode**, plus the tiny extension that hosts the bridge.

## How restart works in VSCode

Restart is a **workbench command**, not an extension-API method:

| What you press | Command id | What actually runs |
|---|---|---|
| Call Stack toolbar **Restart** button | `workbench.action.debug.restart` | `debugService.restartSession(focusedSession)` |
| **Play** button | `workbench.action.debug.start` | `vscode.debug.startDebugging()` — **always a new session/process set** |

VSCode's internal `restartSession` implementation:

1. Saves editors (`saveBeforeRestart`), then re-reads `launch.json` config under the session's root.
2. If the **active debug adapter** declares the DAP capability `supportsRestartRequest` → sends the DAP `restart` request to the adapter with `{ arguments: <resolved config> }`; the adapter relaunches the debuggee **in place** (`debugSession.restart()` → `raw.restart({ arguments: this.configuration })`).
3. Otherwise (most adapters) → `session.terminate(true)` (or `disconnect(true)` for auto-restart) then, after **300ms**, re-resolves the config and re-launches/re-attaches **the same session object** (fires `onDidNewSession(session)` but reuses the session id).
4. With `restartData` (auto-restart, e.g. attach configs with `"restart": true`) it uses `disconnect` and skips task re-runs.

Key semantic: **restart always targets the *focused* session** (same as the toolbar button); Play spawns a disjoint new process set. There is no public `DebugSession.restart()` and no way to restart a non-focused session via the public API — this bridge reproduces that exactly rather than faking it.

## Why not just `code --command ...`?

The VSCode CLI does not expose a general `--command` flag to execute workbench commands in a running window. This bridge instead uses the extension host's command and debugger APIs.

## Architecture

```
agent (MCP client)
   │  stdio JSON-RPC (MCP 2024-11-05)
   ▼
server/index.js  ──HTTP POST 127.0.0.1:8787──►  extension/extension.js (in VSCode)
                                               ├─ vscode.commands.executeCommand('workbench.action.debug.restart')
                                               ├─ vscode.debug.startDebugging / stopDebugging
                                               └─ DebugSession.customRequest(...)
```

The extension keeps a session registry from `onDidStartDebugSession` / `onDidTerminateDebugSession` (the public API otherwise exposes only the *active* session).

## Install

On macOS, keep the project at `~/files/vscode-debug-mcp/`:

```sh
mkdir -p ~/files
git clone https://github.com/ucalyptus/vscode-debug-mcp.git ~/files/vscode-debug-mcp
```

1. **Extension** — the extension is plain JS (no build):
   ```sh
   mkdir -p ~/.vscode/extensions/vscode-debug-mcp-ctl/
   cp "$HOME/files/vscode-debug-mcp/extension/"{package.json,extension.js} ~/.vscode/extensions/vscode-debug-mcp-ctl/
   ```
   Restart VSCode (or reload a window). Console log confirms:
   `[debugctl] control API listening on http://127.0.0.1:8787`
   - Optional hardening: set `debugctl.token` in settings; the API then requires header `x-debugctl-token`.
   - If port 8787 is taken, change `debugctl.port` and point the server at it via `DEBUGCTL_URL`.

2. **MCP server** (Node ≥ 18, no deps):
   ```sh
   node "$HOME/files/vscode-debug-mcp/server/index.js"
   ```
   Register it with any MCP client as a stdio server using `node` and the absolute path to `~/files/vscode-debug-mcp/server/index.js`. Expand `~` to your macOS home directory in JSON configuration; MCP clients do not generally perform shell expansion. From the CLI, `$HOME` is expanded by the shell:
   ```sh
   code --add-mcp "{\"name\":\"vscode-debug-ctl\",\"command\":\"node\",\"args\":[\"$HOME/files/vscode-debug-mcp/server/index.js\"]}"
   ```
   Env: `DEBUGCTL_URL` (default `http://127.0.0.1:8787`), `DEBUGCTL_TOKEN`.

## MCP tools

| Tool | Effect |
|---|---|
| `debug_list_sessions` | `{active, sessions:[{id,name,type,request,isChild}]}` |
| `debug_restart` (`sessionId?`) | Restarts the focused session via `workbench.action.debug.restart` (true restart semantics). Non-focused `sessionId` → error with guidance (matches VSCode's own behavior). |
| `debug_start` (`nameOrConfig`) | `vscode.debug.startDebugging` — **new** session (Play behavior; note the caveat). |
| `debug_stop` (`sessionId?`) | `vscode.debug.stopDebugging`. |
| `debug_custom_request` (`command, args, sessionId?`) | Any DAP request via `customRequest` (e.g. `restart` for adapters with `supportsRestartRequest`). |
| `debug_run_command` (`command, args?`) | Any workbench command (stop/pause/continue/…). |

## Verify

```sh
cd ~/files/vscode-debug-mcp
node --check extension/extension.js
node --check server/index.js
node server/test/integration.test.js   # drives MCP server against a mock of the extension API
```

The test suite covers the handshake, tool listing, session listing, focused-session restart guard, DAP request passthrough, and the unreachable-extension error path **without a GUI**. A live end-to-end check additionally requires an open VSCode window with the extension installed and a running debug session.

## Scripted recipe (equivalent to the agent path)

```js
// inside any VSCode extension or the Debug Console-free context:
await vscode.commands.executeCommand('workbench.action.debug.restart');
// lower level, when adapter supports restart:
await vscode.debug.activeDebugSession.customRequest('restart', { arguments: vscode.debug.activeDebugSession.configuration });
```
