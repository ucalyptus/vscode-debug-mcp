/*
 * Mock of the vscode-debug-mcp-ctl extension HTTP API.
 * Mirrors the extension's exact request shapes and guards (focused-session
 * restriction on restart) so the MCP server can be tested without a GUI.
 * Prints "LISTENING <port>" to stdout when ready.
 */

'use strict';
const http = require('http');

const sessions = [
  { id: 'sess-1', name: 'Attach to server', type: 'node', request: 'attach', isChild: false },
  { id: 'sess-2', name: 'webpack build', type: 'node', request: 'launch', isChild: true }
];
let active = 'sess-1';

const handlers = {
  listSessions() {
    return { ok: true, active, sessions };
  },
  restartSession(payload) {
    if (!active) return { ok: false, error: 'No active debug session to restart.' };
    if (payload.sessionId != null && active !== payload.sessionId) {
      return {
        ok: false,
        error: `Session "${payload.sessionId}" is not the focused session. Restart (workbench.action.debug.restart) always targets the focused session — same as the Call Stack toolbar button. Active session is "${active}". Stop it and start the target instead, or focus it in the UI first.`
      };
    }
    return { ok: true, session: sessions.find((s) => s.id === active) };
  },
  startSession(payload) {
    if (payload.nameOrConfig == null) return { ok: false, error: 'Provide nameOrConfig (launch.json config name or a full DebugConfiguration object).' };
    const s = { id: 'sess-new', name: typeof payload.nameOrConfig === 'string' ? payload.nameOrConfig : payload.nameOrConfig.name, type: 'x', request: 'launch', isChild: false };
    sessions.unshift(s);
    active = s.id;
    return { ok: true, started: true, session: s };
  },
  stopSession(payload) {
    return { ok: true, stopped: payload.sessionId || active };
  },
  customRequest(payload) {
    if (!payload.command) return { ok: false, error: 'DAP command is required.' };
    return { ok: true, session: payload.sessionId || active, result: { request: payload.command, echoed: payload.args || {} } };
  },
  runCommand(payload) {
    if (!payload.command) return { ok: false, error: 'command id required.' };
    return { ok: true, result: 'ran ' + payload.command };
  }
};

const server = http.createServer(async (req, res) => {
  const write = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return write(200, { ok: true });
  if (req.method !== 'POST') return write(404, { ok: false, error: 'POST /<action> only' });
  let raw = '';
  for await (const c of req) raw += c;
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { return write(400, { ok: false, error: 'Invalid JSON body.' }); }
  const fn = handlers[req.url.replace(/^\//, '')];
  if (!fn) return write(404, { ok: false, error: `Unknown action` });
  try { write(200, await fn(payload)); } catch (e) { write(500, { ok: false, error: e.message }); }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});