#!/usr/bin/env node
// Development/CI probe only. This file is not shipped as a native runtime.
// It never sends turn/start or reads the owner's Codex configuration/credentials.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, platform, release } from 'node:os';
import { resolve, isAbsolute, join, extname } from 'node:path';
import { performance } from 'node:perf_hooks';

class ProbeAssertionError extends Error {}
function assertProbe(condition, message) {
  if (!condition) throw new ProbeAssertionError(message);
}

const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') { options.set(key, true); continue; }
  if (!['--codex', '--out', '--expect-version'].includes(key) || !process.argv[i + 1]) throw new Error(`Unknown or incomplete argument: ${key}`);
  options.set(key, process.argv[++i]);
}
if (options.has('--help')) {
  console.log('Usage: node scripts/probe-codex.mjs --codex ABSOLUTE_NATIVE_EXE --out EVIDENCE_DIRECTORY [--expect-version EXACT_VERSION]\nRuns initialize and thread metadata only in a disposable profile. No model turn, credentials, tools, downloads, or sandbox bypass. Exit 0: metadata passed; 2: target unavailable; 1: failed assertion.');
  process.exit(0);
}
const executable = options.get('--codex');
if (!executable || !isAbsolute(executable) || !(await stat(executable)).isFile()) throw new Error('--codex must name an existing absolute native executable');
if (platform() === 'win32' && extname(executable).toLowerCase() !== '.exe') throw new Error('Windows requires the native codex.exe, not a PowerShell/CMD shim');
if (!options.has('--out')) throw new Error('--out is required');
const output = resolve(options.get('--out'));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'studio-codex-probe-'));
const home = join(scratch, 'codex-profile');
const workspace = join(scratch, 'empty-project');
await mkdir(home); await mkdir(workspace);
const limits = { lineBytes: 1024 * 1024, transcriptBytes: 128 * 1024, stderrBytes: 64 * 1024, rpcTimeoutMs: 15000 };
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'unavailable',
  platform: platform(), osRelease: release(), executable,
  credentialsInherited: false, callerProfileConfigured: false, disposableProfile: true,
  turnStartSent: false, modelEndpointRequests: 0, rejectedProxyRequests: 0,
  networkContainmentClaimed: false, localToolsLoaded: false,
  windowsAcceptance: false, fullDirectProfileAcceptance: false,
  commands: [], checks: [], limits,
};
const transcript = []; let transcriptBytes = 0; let transcriptDropped = 0;
function record(direction, frame) {
  const entry = { direction, atMs: Math.round(performance.now()), frame };
  const size = Buffer.byteLength(JSON.stringify(entry));
  if (transcriptBytes + size <= limits.transcriptBytes) { transcript.push(entry); transcriptBytes += size; }
  else transcriptDropped++;
}
const blocked = [];
const rejector = createServer((request, response) => {
  const proxied = /^https?:\/\//i.test(request.url ?? '');
  if (proxied) report.rejectedProxyRequests++; else report.modelEndpointRequests++;
  if (blocked.length < 64) blocked.push({ kind: proxied ? 'proxy-request' : 'provider-endpoint', method: request.method, path: request.url?.slice(0, 200) });
  request.resume(); response.writeHead(503, { Connection: 'close' }); response.end('No inference is permitted in this protocol probe.');
});
rejector.on('connect', (request, socket) => {
  report.rejectedProxyRequests++;
  if (blocked.length < 64) blocked.push({ kind: 'proxy-connect', target: request.url?.slice(0, 200) });
  socket.end('HTTP/1.1 503 Offline protocol probe\r\nConnection: close\r\n\r\n');
});
await new Promise((ok, fail) => { rejector.once('error', fail); rejector.listen(0, '127.0.0.1', ok); });
const endpoint = `http://127.0.0.1:${rejector.address().port}`;
// Only execution essentials are inherited. In particular, no API keys, tokens,
// user profile paths, or user MCP/header configuration are copied.
const childEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG'].includes(key.toUpperCase())) childEnvironment[key] = value;
}
Object.assign(childEnvironment, {
  CODEX_HOME: home, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
  http_proxy: endpoint, https_proxy: endpoint, all_proxy: endpoint,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});
const settings = [
  'model_provider="studio_protocol_probe"', 'model="studio-no-inference"',
  `model_providers.studio_protocol_probe={name="Studio protocol probe",base_url="${endpoint}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
  'analytics.enabled=false', 'feedback.enabled=false', 'web_search="disabled"',
  'features.computer_use=false', 'computer_use.default_app_access="deny"',
];
const args = settings.flatMap(setting => ['-c', setting]);
const spawnOptions = { cwd: workspace, env: childEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
async function capture(arguments_, byteLimit = 8192) {
  return new Promise((ok, fail) => {
    const child = spawn(executable, arguments_, spawnOptions);
    let stdout = '', stderr = ''; let size = 0; let exceeded = false;
    const timer = setTimeout(() => child.kill(), limits.rpcTimeoutMs);
    function keep(chunk, isError) {
      size += chunk.length;
      if (size > byteLimit) { exceeded = true; child.kill(); return; }
      if (isError) stderr += chunk; else stdout += chunk;
    }
    child.stdout.on('data', chunk => keep(chunk, false)); child.stderr.on('data', chunk => keep(chunk, true));
    child.on('error', fail); child.on('close', (code, signal) => { clearTimeout(timer); ok({ code, signal, stdout, stderr, exceeded }); });
    child.stdin.end();
  });
}

let child; let childClosed; let pendingBuffer = Buffer.alloc(0); let stderr = Buffer.alloc(0); let stderrObserved = 0;
let protocolFailure;
const pending = new Map();
const allowed = new Set(['initialize', 'initialized', 'thread/start', 'thread/read', 'thread/turns/list', 'thread/resume']);
let nextId = 0;
function rejectPending(error) {
  if (error instanceof ProbeAssertionError) protocolFailure ??= error;
  for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear();
}
function send(frame) {
  if (protocolFailure) throw protocolFailure;
  assertProbe(!frame.method || allowed.has(frame.method), `Probe cannot send ${frame.method}`);
  if (frame.method) report.commands.push(frame.method);
  record('send', frame); child.stdin.write(`${JSON.stringify(frame)}\n`);
}
function call(method, params) {
  const id = `probe_${++nextId}`;
  return new Promise((ok, fail) => {
    const started = performance.now();
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`Timed out: ${method}`)); }, limits.rpcTimeoutMs);
    pending.set(id, { resolve: value => { report.checks.push({ method, outcome: value.error ? 'rpc-error' : 'received', durationMs: Math.round(performance.now() - started) }); ok(value); }, reject: fail, timer });
    try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); fail(error); }
  });
}
function receive(frame) {
  assertProbe(frame !== null && typeof frame === 'object' && !Array.isArray(frame), 'App Server frame must be a JSON object');
  assertProbe(frame.method !== undefined || frame.id !== undefined, 'App Server frame has neither method nor response ID');
  if (frame.method !== undefined) assertProbe(typeof frame.method === 'string' && frame.method.length > 0, 'App Server method must be a nonempty string');
  record('receive', frame);
  if (frame.method && frame.id !== undefined) {
    // Unexpected server requests never grant authority, execute a tool, or open UI.
    report.unexpectedServerRequests = (report.unexpectedServerRequests ?? 0) + 1;
    let result;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(frame.method)) result = { decision: 'decline' };
    if (frame.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    send(result ? { id: frame.id, result } : { id: frame.id, error: { code: -32601, message: 'Metadata-only probe: client action unavailable' } });
  } else if (frame.id !== undefined) {
    const request = pending.get(frame.id);
    if (request) { pending.delete(frame.id); clearTimeout(request.timer); request.resolve(frame); }
  }
}
function requireResult(response, method) {
  if (response.error) {
    assertProbe(typeof response.error.message === 'string' && Number.isInteger(response.error.code), `${method}: malformed RPC error`);
    // A rejected method/parameter is protocol incompatibility, not a missing OS
    // facility. Runtime/sandbox/policy errors retain the unavailable outcome.
    const ErrorClass = [-32600, -32601, -32602].includes(response.error.code) ? ProbeAssertionError : Error;
    const error = new ErrorClass(`${method}: ${response.error.message}`); error.rpcCode = response.error.code; throw error;
  }
  assertProbe(Object.hasOwn(response, 'result'), `${method}: missing result`);
  assertProbe(response.result !== null && typeof response.result === 'object' && !Array.isArray(response.result), `${method}: result must be an object`);
  return response.result;
}

try {
  const version = await capture(['--version']);
  if (version.code !== 0 || version.exceeded) throw new Error('Cannot determine native Codex version');
  report.version = version.stdout.trim();
  const expected = options.get('--expect-version');
  assertProbe(!expected || report.version === expected || report.version === `codex-cli ${expected}`, `Codex version mismatch: expected ${expected}, received ${report.version}`);
  // Config is fresh; managed machine policy can still impose additional limits.
  child = spawn(executable, [...args, 'app-server'], spawnOptions);
  childClosed = new Promise(ok => child.once('close', (code, signal) => {
    report.processExit = { code, signal };
    rejectPending(pendingBuffer.length ? new ProbeAssertionError('App Server closed with an incomplete JSON frame') : new Error('App Server closed before a reply'));
    ok();
  }));
  child.on('error', error => rejectPending(error));
  child.stdin.on('error', error => rejectPending(error));
  child.stderr.on('data', chunk => {
    stderrObserved += chunk.length;
    const remaining = Math.max(0, limits.stderrBytes - stderr.length);
    if (remaining) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
  });
  child.stdout.on('data', chunk => {
    pendingBuffer = Buffer.concat([pendingBuffer, chunk]);
    while (true) {
      const newline = pendingBuffer.indexOf(10);
      if (newline < 0) break;
      if (newline > limits.lineBytes) { rejectPending(new ProbeAssertionError('App Server frame exceeded probe budget')); child.kill(); return; }
      const line = pendingBuffer.subarray(0, newline).toString('utf8'); pendingBuffer = pendingBuffer.subarray(newline + 1);
      try { receive(JSON.parse(line)); } catch (error) { rejectPending(error instanceof SyntaxError ? new ProbeAssertionError(`Malformed App Server JSON: ${error.message}`) : error); child.kill(); return; }
    }
    if (pendingBuffer.length > limits.lineBytes) { rejectPending(new ProbeAssertionError('Unterminated App Server frame exceeded probe budget')); child.kill(); }
  });
  const initialize = requireResult(await call('initialize', {
    clientInfo: { name: 'platform_studio_protocol_probe', title: 'Platform Studio offline protocol probe', version: '0.5.0' },
    capabilities: { experimentalApi: false },
  }), 'initialize');
  assertProbe(typeof initialize.userAgent === 'string' && initialize.userAgent.length > 0, 'initialize did not return a userAgent');
  report.handshake = true; report.serverUserAgent = initialize.userAgent;
  send({ method: 'initialized' });
  const start = requireResult(await call('thread/start', {
    cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never',
    developerInstructions: 'Metadata-only protocol probe. No turn, tool, or inference request will be sent.',
  }), 'thread/start');
  const threadId = start.thread?.id;
  assertProbe(typeof threadId === 'string' && threadId.length > 0, 'thread/start did not return a thread ID');
  report.threadCreated = true;
  const read = requireResult(await call('thread/read', { threadId }), 'thread/read');
  assertProbe(read.thread?.id === threadId, 'thread/read returned a different thread');
  const turns = requireResult(await call('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full' }), 'thread/turns/list');
  assertProbe(Array.isArray(turns.data), 'thread/turns/list did not return a data array');
  assertProbe(turns.data.length === 0, 'Fresh metadata-only thread unexpectedly contains turns');
  const resumed = requireResult(await call('thread/resume', { threadId, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true }), 'thread/resume');
  assertProbe(resumed.thread?.id === threadId, 'thread/resume returned a different thread');
  report.status = 'metadata-passed';
} catch (error) {
  report.status = error instanceof ProbeAssertionError ? 'assertion-failed' : report.handshake ? 'metadata-unavailable' : 'handshake-unavailable';
  report.reason = String(error.message).slice(0, 2000);
  if (error.rpcCode !== undefined) report.rpcCode = error.rpcCode;
} finally {
  if (child) {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await childClosed; clearTimeout(timer);
  }
  report.turnStartSent = report.commands.includes('turn/start');
  if (protocolFailure) { report.status = 'assertion-failed'; report.reason = String(protocolFailure.message).slice(0, 2000); }
  if (report.turnStartSent || report.modelEndpointRequests !== 0 || report.unexpectedServerRequests) {
    report.status = 'assertion-failed';
    report.reason = 'Forbidden inference request or unexpected server action observed; nothing was forwarded.';
  }
  report.stderrObservedBytes = stderrObserved; report.stderrSavedBytes = stderr.length;
  report.transcriptSavedBytes = transcriptBytes; report.transcriptDroppedFrames = transcriptDropped;
  report.finishedAt = new Date().toISOString();
  rejector.closeAllConnections(); await new Promise(ok => rejector.close(ok));
  try { await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); report.disposableProfileRemoved = true; }
  catch { report.disposableProfileRemoved = false; }
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
  await writeFile(join(output, 'blocked-network.json'), `${JSON.stringify(blocked, null, 2)}\n`);
  await writeFile(join(output, 'stderr.log'), stderr);
}
console.log(JSON.stringify({ status: report.status, version: report.version, handshake: report.handshake ?? false, turnStartSent: report.turnStartSent, modelEndpointRequests: report.modelEndpointRequests, rejectedProxyRequests: report.rejectedProxyRequests, reason: report.reason, evidence: output }, null, 2));
process.exitCode = report.status === 'metadata-passed' ? 0 : report.status === 'assertion-failed' ? 1 : 2;
