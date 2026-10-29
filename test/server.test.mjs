import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const serverPath = join(import.meta.dirname, '..', 'build', 'server', 'server.js');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(t) {
  const port = await getFreePort();
  const home = mkdtempSync(join(tmpdir(), 'pi-web-test-'));
  const fakeNpx = join(home, 'npx');
  writeFileSync(fakeNpx, '#!/bin/sh\ncat > /dev/null\n');
  chmodSync(fakeNpx, 0o755);
  const proc = spawn(process.execPath, [serverPath, '--port', String(port)], {
    env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proc.kill());
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) resolve();
    });
    proc.on('exit', () => reject(new Error('server exited before start')));
  });
  return { port, proc };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function sendWs(port, payloads) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('error', reject);
    ws.on('open', () => {
      for (const payload of payloads) ws.send(payload);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 300);
    });
  });
}

test('survives malformed websocket messages', async (t) => {
  const { port, proc } = await startServer(t);
  await sendWs(port, [
    'null',
    '1',
    JSON.stringify({ type: 'start_session', cwd: tmpdir() }),
    JSON.stringify({ type: 'rpc_command' }),
  ]);
  assert.equal(proc.exitCode, null);
  assert.equal(await get(port, '/api/folders'), 200);
});

test('survives an invalid host header or path', async (t) => {
  const { port, proc } = await startServer(t);
  await get(port, '/api/folders', { Host: '[' }).catch(() => {});
  await get(port, '//[', { Accept: 'text/html' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(proc.exitCode, null);
  assert.equal(await get(port, '/api/folders'), 200);
});

function openWs(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
}

test('rejects websocket connections from other origins', async (t) => {
  const { port } = await startServer(t);
  assert.equal(await openWs(port, { Origin: 'https://evil.example' }), 401);
  assert.equal(await openWs(port, { Origin: `http://127.0.0.1:${port}` }), 'open');
  assert.equal(await openWs(port, {}), 'open');
});
