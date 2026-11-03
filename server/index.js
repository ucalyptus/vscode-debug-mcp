#!/usr/bin/env node
/*
 * vscode-debug-mcp: MCP server (stdio) exposing VSCode debugger control
 * to an agent. Proxies every tool call to the vscode-debug-mcp-ctl
 * extension's loopback HTTP API.
 *
 * Env:
 *   DEBUGCTL_URL   default http://127.0.0.1:8787
 *   DEBUGCTL_TOKEN optional shared secret -> sent as x-debugctl-token
 *
 * MCP protocol: JSON-RPC 2.0 over newline-delimited stdio,
 * protocolVersion 2024-11-05 (tools/list + tools/call only).
 */

'use strict';

const BASE_URL = process.env.DEBUGCTL_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.DEBUGCTL_TOKEN || '';
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'debug_list_sessions',
    description:
      'List live VSCode debug sessions ({id, name, type, request, isChild}) and the currently focused session id. ' +
      'Use this before debug_restart to know which session the restart will actually act on (always the focused one).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'debug_restart',
    description:
      'Restart the focused VSCode debug session — the exact same code path as the Restart button in the Call Stack pane ' +
      '(workbench.action.debug.restart -> debugService.restartSession). If the active debug adapter declares ' +
      'supportsRestartRequest, a DAP "restart" request is sent and the adapter relaunches in place; otherwise VSCode ' +
      'terminates the session and relaunches it. This REUSES the session; unlike debug_start it does not spawn a second ' +
      'disjoint set of processes. Optional sessionId: must equal the focused session, else the call fails with guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional. Must be the currently focused session (see debug_list_sessions).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'debug_start',
    description:
      'Start a NEW debug session via vscode.debug.startDebugging (same as pressing the Play button). ' +
      'This always creates a new process set — use debug_restart when the goal is restarting the existing session. ' +
      'Pass either a launch.json configuration name (string) or a full DebugConfiguration object.',
    inputSchema: {
      type: 'object',
      properties: {
        nameOrConfig: {
          oneOf: [
            { type: 'string', description: 'Name of a configuration in launch.json (root workspace folder).' },
            { type: 'object', description: 'Full DebugConfiguration, e.g. {type:"node", name:"x", request:"launch", program:"${file}"}' }
          ]
        }
      },
      required: ['nameOrConfig'],
      additionalProperties: false
    }
  },
  {
    name: 'debug_stop',
    description: 'Stop a debug session (vscode.debug.stopDebugging). Omitting sessionId stops the focused session.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'debug_custom_request',
    description:
      'Send an arbitrary Debug Adapter Protocol request to a session (DebugSession.customRequest). ' +
      'Lowest-level control: e.g. command "restart" (only honored by adapters with supportsRestartRequest capability; ' +
      'prefer debug_restart which also covers the relaunch fallback), "pause", "continue", "evaluate", ...',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional; defaults to focused session.' },
        command: { type: 'string', description: 'DAP request name, e.g. "restart", "continue", "evaluate".' },
        args: { type: 'object', description: 'DAP request arguments.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'debug_run_command',
    description:
      'Run any VSCode workbench command (vscode.commands.executeCommand). ' +
      'Useful for adjacent control: workbench.action.debug.stop, workbench.action.debug.pause, workbench.action.debug.continue, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: {}
      },
      required: ['command'],
      additionalProperties: false
    }
  }
];

const ROUTE = {
  debug_list_sessions: ['listSessions', {}],
  debug_restart: ['restartSession', { sessionId: true }],
  debug_start: ['startSession', { nameOrConfig: true }],
  debug_stop: ['stopSession', { sessionId: true }],
  debug_custom_request: ['customRequest', { sessionId: true, command: true, args: true }],
  debug_run_command: ['runCommand', { command: true, args: true }]
};

async function callBackend(action, payload) {
  const res = await fetch(`${BASE_URL}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { 'x-debugctl-token': TOKEN } : {})
    },
    body: JSON.stringify(payload)
  });
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = { ok: false, error: text || res.statusText }; }
  return { status: res.status, body };
}

function resultText(result) {
  return JSON.stringify(result, null, 2);
}

function toolCall(name, args) {
  const route = ROUTE[name];
  if (!route) return { error: `Unknown tool: ${name}` };
  const [action, keep] = route;
  const payload = {};
  for (const key of Object.keys(keep)) {
    if (args[key] !== undefined) payload[key] = args[key];
  }
  return { action, payload };
}

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const serverInfo = { name: 'vscode-debug-mcp', version: require('./package.json').version };
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo
        }
      };
    }
    case 'notifications/initialized':
    case 'notifications/roots/list_changed':
      return null; // no response
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call': {
      const { name, arguments: args } = params || {};
      const t = toolCall(name, args || {});
      if (t.error) {
        return { error: { code: -32602, message: t.error } };
      }
      try {
        const { status, body } = await callBackend(t.action, t.payload);
        if (status === 200 && body && body.ok !== false) {
          return { result: { content: [{ type: 'text', text: resultText(body) }] } };
        }
        const errMsg = (body && body.error) || `HTTP ${status}`;
        return {
          result: {
            content: [{ type: 'text', text: errMsg }],
            isError: true
          }
        };
      } catch (e) {
        return {
          result: {
            content: [{
              type: 'text',
              text: `Cannot reach VSCode at ${BASE_URL}. Is the vscode-debug-mcp-ctl extension installed and a window open? (${e.message})`
            }],
            isError: true
          }
        };
      }
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const response = await handle(msg);
  if (response === null) return; // notification
  const out = { jsonrpc: '2.0' };
  if (msg.id !== undefined) out.id = msg.id;
  if (response.error) out.error = response.error;
  else out.result = response.result;
  process.stdout.write(JSON.stringify(out) + '\n');
});

rl.on('close', () => process.exit(0));