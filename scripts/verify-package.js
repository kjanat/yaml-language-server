import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Console } from 'node:console';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'yaml-language-server-package-'));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this script with `npm run verify-package`');
const runNpm = (args) =>
  spawnSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

try {
  const packed = runNpm(['pack', '--json', '--pack-destination', temporaryDirectory]);
  assert.equal(packed.status, 0, packed.stderr);

  const packedMetadata = JSON.parse(packed.stdout);
  const packageMetadata = Array.isArray(packedMetadata) ? packedMetadata[0] : Object.values(packedMetadata)[0];
  assert(packageMetadata, 'npm pack did not report package metadata');
  const packedFiles = new Set(packageMetadata.files.map(({ path: filePath }) => filePath));
  for (const requiredFile of ['bin/yaml-language-server', 'out/src/server.js', 'out/src/index.js']) {
    assert(packedFiles.has(requiredFile), `packed package is missing ${requiredFile}`);
  }
  assert([...packedFiles].some((filePath) => filePath.startsWith('out/src/languageservice/')));

  const packageFile = path.join(temporaryDirectory, packageMetadata.filename);
  const installDirectory = path.join(temporaryDirectory, 'consumer');
  const installed = runNpm(['install', '--prefix', installDirectory, '--ignore-scripts', '--no-audit', '--no-fund', packageFile]);
  assert.equal(installed.status, 0, installed.stderr);

  const executable = path.join(installDirectory, 'node_modules', 'yaml-language-server', 'bin', 'yaml-language-server');
  const server = spawn(process.execPath, [executable, '--stdio'], {
    cwd: installDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = '';
  const pending = new Map();
  let nextId = 1;

  server.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    while (true) {
      const headerEnd = stdout.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = stdout.subarray(0, headerEnd).toString('ascii');
      const contentLength = Number(header.match(/Content-Length: (\d+)/i)?.[1]);
      if (!Number.isSafeInteger(contentLength) || stdout.length < headerEnd + 4 + contentLength) return;
      const message = JSON.parse(stdout.subarray(headerEnd + 4, headerEnd + 4 + contentLength).toString('utf8'));
      stdout = stdout.subarray(headerEnd + 4 + contentLength);
      if (typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const request = (method, params) => {
    const id = nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    server.stdin.write(body);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for LSP ${method} response. ${stderr}`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  };

  try {
    const initialized = await request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
    assert(initialized.result?.capabilities);
    assert(initialized.result.capabilities.completionProvider?.triggerCharacters?.includes('.'));
    const shutdown = await request('shutdown', null);
    assert.equal(shutdown.error, undefined, JSON.stringify(shutdown.error));
    const exit = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }), 'utf8');
    server.stdin.write(`Content-Length: ${exit.length}\r\n\r\n`);
    server.stdin.end(exit);
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for CLI exit. ${stderr}`)), 5000);
      server.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (server.exitCode === null) {
      server.kill();
    }
  }

  new Console(process.stdout, process.stderr).log('Packed CLI passed LSP initialize/shutdown/exit smoke test.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
