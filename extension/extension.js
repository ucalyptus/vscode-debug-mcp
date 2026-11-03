/*
 * vscode-debug-mcp-ctl
 * --------------------
 * Runs INSIDE VSCode (extension host, desktop).
 *
 * Bridges an external agent / MCP client to the running debugger:
 *   - hosts a loopback HTTP API on 127.0.0.1:debugctl.port
 *   - the real work is done through VSCode's own command/API surface,
 *     so semantics match the Call Stack toolbar exactly:
 *       restart   -> workbench.action.debug.restart
 *                    (debugService.restartSession(activeSession):
 *                      DAP 'restart' when adapter supportsRestartRequest,
 *                      else terminate(true) + relaunch after 300ms)
 *       start     -> vscode.debug.startDebugging   (creates a NEW session)
 *       stop      -> vscode.debug.stopDebugging
 *       raw       -> DebugSession.customRequest(...)  (arbitrary DAP request)
 *
 * Security: binds loopback only. Set debugctl.token to require a shared secret.
 */

const vscode = require('vscode');
const http = require('http');

const RESTART_CMD = 'workbench.action.debug.restart'; // RESTART_SESSION_ID in debugCommands.ts

let server = null;

/** Map of live sessions id -> {session, meta}, kept from onDidStart/onDidTerminate events. */
const registry = new Map();

function bodyOfRequest(session) {
  if (!session) return null;
  const cfg = session.configuration || {};
  return {
    id: session.id,
    name: cfg.name || session.name || String(session.id),
    type: session.type,
    request: cfg.request || (cfg.attach ? 'attach' : 'launch'),
    isChild: !!session.parentSession // part of a compound / parent-managed group
  };
}

function activeSession() {
  return vscode.debug.activeDebugSession || undefined;
}

function findSession(id) {
  if (id == null) return activeSession();
  const e = registry.get(id);
  return e ? e.session : undefined;
}

/* ------------------------------------------------------------------ *
 * Handlers: each takes a single JSON payload; also exposed as a       *
 * workbench command so humans can trigger them from the palette.     *
 * ------------------------------------------------------------------ */

function listSessions() {
  const active = activeSession();
  const sessions = [...registry.values()].map((e) => e.meta);
  return { ok: true, active: active ? active.id : null, sessions };
}

async function restartSession(payload = {}) {
  const active = activeSession();
  const err = [];
  if (!active) err.push('No active debug session to restart.');
  if (!err.length && payload.sessionId != null && active.id !== payload.sessionId) {
    err.push(
      `Session "${payload.sessionId}" is not the focused session. Restart (workbench.action.debug.restart) ` +
      'always targets the focused session — same as the Call Stack toolbar button. ' +
      `Active session is "${active.id}". Stop it and start the target instead, or focus it in the UI first.`
    );
  }
  if (err.length) return { ok: false, error: err.join(' ') };

  await vscode.commands.executeCommand(RESTART_CMD); // rejects if restart fails
  return { ok: true, session: bodyOfRequest(active) };
}

async function startSession(payload = {}) {
  const nameOrConfig = payload.nameOrConfig || payload.configuration;
  if (nameOrConfig == null) {
    return { ok: false, error: 'Provide nameOrConfig (launch.json config name or a full DebugConfiguration object).' };
  }
  let folder = undefined;
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
    folder = vscode.workspace.workspaceFolders[0];
  }
  const started = await vscode.debug.startDebugging(folder, nameOrConfig, payload.options);
  if (!started) return { ok: false, error: `Debugging did not start for ${JSON.stringify(nameOrConfig)}.` };
  const s = activeSession();
  return { ok: true, started: true, session: s ? bodyOfRequest(s) : null };
}

async function stopSession(payload = {}) {
  const target = findSession(payload.sessionId);
  if (!target) {
    const active = activeSession();
    if (active) {
      await vscode.debug.stopDebugging(active);
      return { ok: true, stopped: active.id };
    }
    return { ok: false, error: 'No debug session to stop.' };
  }
  await vscode.debug.stopDebugging(target);
  return { ok: true, stopped: target.id };
}

async function customRequest(payload = {}) {
  const target = findSession(payload.sessionId);
  if (!target) return { ok: false, error: 'No active debug session.' };
  if (!payload.command) return { ok: false, error: 'DAP command is required.' };
  const result = await target.customRequest(payload.command, payload.args);
  return { ok: true, session: target.id, result: result ?? null };
}

/** Escape hatch: run any workbench command (e.g. workbench.action.debug.stop, workbench.action.debug.pause, ...). */
async function runCommand(payload = {}) {
  if (typeof payload.command !== 'string' || !payload.command) return { ok: false, error: 'command id required.' };
  const result = await vscode.commands.executeCommand(payload.command, payload.args);
  return { ok: true, result: result ?? null };
}

const handlers = { listSessions, restartSession, startSession, stopSession, customRequest, runCommand };

/* ------------------------------------------------------------------ *
 * Loopback HTTP transport.                                            *
 * ------------------------------------------------------------------ */

function authorize(req) {
  const token = vscode.workspace.getConfiguration('debugctl').token;
  if (!token) return true;
  const got = req.headers['x-debugctl-token'];
  return typeof got === 'string' && got === token;
}

function startControlServer() {
  const cfg = vscode.workspace.getConfiguration('debugctl');
  const port = cfg.port;
  const token = cfg.token;

  stopControlServer();

  server = http.createServer(async (req, res) => {
    const write = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') return write(200, { ok: true });
    if (req.method !== 'POST' || !req.url) return write(404, { ok: false, error: 'POST /<action> only' });
    if (!authorize(req)) return write(401, { ok: false, error: 'Missing or invalid x-debugctl-token header.' });

    let payload = {};
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { return write(400, { ok: false, error: 'Invalid JSON body.' }); }

    const action = req.url.replace(/^\//, '');
    const fn = handlers[action];
    if (!fn) return write(404, { ok: false, error: `Unknown action: ${action}` });

    try {
      const result = await fn(payload);
      write(200, result);
    } catch (e) {
      write(500, { ok: false, error: (e && e.message) || String(e) });
    }
  });

  server.on('error', (e) => {
    vscode.window.showErrorMessage(`DebugCTL: control server error on port ${port}: ${e.message}`);
    server = null;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[debugctl] control API listening on http://127.0.0.1:${port}${token ? ' (token required)' : ''}`);
  });
}

function stopControlServer() {
  if (server) { try { server.close(); } catch {} server = null; }
}

/* ------------------------------------------------------------------ *
 * Activation / lifecycle.                                            *
 * ------------------------------------------------------------------ */

function activate(context) {
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((s) => {
    registry.set(s.id, { session: s, meta: bodyOfRequest(s) });
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((s) => {
    registry.delete(s.id);
  }));
  const active = activeSession();
  if (active) registry.set(active.id, { session: active, meta: bodyOfRequest(active) });

  for (const name of Object.keys(handlers)) {
    const fn = handlers[name];
    const bound = name === 'listSessions'
      ? () => fn()
      : (arg) => fn(typeof arg === 'object' && arg !== null ? arg : undefined);
    context.subscriptions.push(vscode.commands.registerCommand(`debugctl.${name}`, bound));
  }

  startControlServer();
  context.subscriptions.push({ dispose: stopControlServer });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('debugctl')) startControlServer();
  }));
}

function deactivate() {
  stopControlServer();
}

module.exports = { activate, deactivate };