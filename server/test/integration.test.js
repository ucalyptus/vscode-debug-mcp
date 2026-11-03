/*
 * Drives the MCP server the way an MCP client would (newline-delimited
 * JSON-RPC over stdio) against the mock backend, and asserts:
 *   - initialize handshake protocol version
 *   - tools/list exposes debug_restart
 *   - debug_list_sessions returns registry + focused session
 *   - debug_restart on focused session succeeds
 *   - debug_restart on a non-focused session fails with the focused-session guard
 *   - debug_custom_request passes command+args through to the session
 *   - backend unreachable -> isError result with actionable message
 */

'use strict';
const { spawn } = require('child_process');
const { once } = require('events');
const path = require('path');
const http = require('http');

const SERVER = path.join(__dirname, '..', 'index.js');
const MOCK = path.join(__dirname, 'mock-backend.js');

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}`); }
}

async function startMock() {
  const child = spawn(process.execPath, [MOCK], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error('mock backend exited early')));
  });
  return { child, port };
}

function startMcp(env) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  const pending = new Map();
  let lineBuf = '';
  child.stdout.on('data', (d) => {
    lineBuf += d.toString();
    let i;
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i).trim();
      lineBuf = lineBuf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  const send = (method, params, id) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  child.send = send;
  return child;
}

async function main() {
  const mock = await startMock();
  const mcp = startMcp({ DEBUGCTL_URL: `http://127.0.0.1:${mock.port}` });

  const init = await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} }, 1);
  assert(init.result.protocolVersion === '2024-11-05', 'initialize returns protocolVersion');
  assert(init.result.serverInfo.name === 'vscode-debug-mcp', 'initialize returns serverInfo');

  const tools = await mcp.send('tools/list', {}, 2);
  const names = tools.result.tools.map((t) => t.name);
  assert(names.includes('debug_restart') && names.includes('debug_list_sessions'), 'tools/list exposes debug_restart + debug_list_sessions');
  const restartTool = tools.result.tools.find((t) => t.name === 'debug_restart');
  assert(restartTool.inputSchema.properties.sessionId, 'debug_restart schema has sessionId');
  assert(/focused session/.test(restartTool.description), 'debug_restart description documents focused-session semantics');

  const list = await mcp.send('tools/call', { name: 'debug_list_sessions', arguments: {} }, 3);
  const listBody = JSON.parse(list.result.content[0].text);
  assert(listBody.ok && listBody.sessions.length === 2 && listBody.active === 'sess-1', 'debug_list_sessions returns registry + focused id');

  const restartOk = await mcp.send('tools/call', { name: 'debug_restart', arguments: { sessionId: 'sess-1' } }, 4);
  const rOk = JSON.parse(restartOk.result.content[0].text);
  assert(rOk.ok === true && rOk.session.id === 'sess-1', 'debug_restart on focused session succeeds');

  const restartWrong = await mcp.send('tools/call', { name: 'debug_restart', arguments: { sessionId: 'sess-2' } }, 5);
  assert(restartWrong.result.isError === true, 'non-focused restart reports isError');
  assert(/not the focused session/.test(restartWrong.result.content[0].text), 'non-focused restart carries guard message');

  const custom = await mcp.send('tools/call', { name: 'debug_custom_request', arguments: { command: 'evaluate', args: { expression: '1+1' } } }, 6);
  const rCustom = JSON.parse(custom.result.content[0].text);
  assert(rCustom.ok && rCustom.result.request === 'evaluate' && rCustom.result.echoed.expression === '1+1', 'debug_custom_request forwards command+args');

  const unknown = await mcp.send('tools/call', { name: 'debug_nope', arguments: {} }, 7);
  assert(unknown.error && unknown.error.code === -32602, 'unknown tool returns -32602');

  mcp.kill();
  mock.child.kill();

  // Backend unreachable -> actionable isError
  const dead = startMcp({ DEBUGCTL_URL: 'http://127.0.0.1:1' });
  const fail = await dead.send('tools/call', { name: 'debug_restart', arguments: {} }, 8);
  assert(fail.result.isError === true, 'unreachable backend -> isError');
  assert(/vscode-debug-mcp-ctl extension/.test(fail.result.content[0].text), 'unreachable message names the extension');
  dead.kill();

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });