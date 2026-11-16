'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parsePackage, declaredManager, detectManager, invocation, taskKey, completionStatus } = require('../src/core');

test('Reads scripts without evaluating or altering commands, including HTML and unusual keys', () => {
  const data = parsePackage('\uFEFF' + JSON.stringify({ name: 'demo', scripts: {
    dev: 'vite --host', 'test:unit': 'node --test', '__proto__': 'ignored by object literal',
    '<img src=x onerror=alert(1)>': 'echo "</script>"'
  } }));
  assert.equal(data.name, 'demo');
  assert.deepEqual(data.scripts.map(item => item.name), ['dev', 'test:unit', '<img src=x onerror=alert(1)>']);
  assert.equal(data.scripts[2].command, 'echo "</script>"');
});

test('Malformed package files report a useful error; absent scripts are valid', () => {
  for (const input of ['{', '[]', 'null', '{"scripts":[]}', '{"scripts":null}', '{"scripts":{"dev":12}}']) {
    assert.throws(() => parsePackage(input));
  }
  assert.deepEqual(parsePackage('{}').scripts, []);
});

test('Only supported managers can become executable names', () => {
  assert.equal(declaredManager('npm@11.9.0'), 'npm');
  assert.equal(declaredManager('pnpm@10.0.0+sha512.test'), 'pnpm');
  assert.equal(declaredManager('npm && echo unexpected'), undefined);
  assert.throws(() => invocation('npm && echo unexpected', 'dev'));
  assert.deepEqual(invocation('npm', 'build:prod', 'win32'), { executable: 'npm.cmd', args: ['run', 'build:prod'] });
  assert.deepEqual(invocation('bun', 'dev', 'win32'), { executable: 'bun.exe', args: ['run', 'dev'] });
  assert.deepEqual(invocation('yarn', 'test unit', 'linux'), { executable: 'yarn', args: ['run', 'test unit'] });
  for (const name of ['bad\nname', '%PATH%', '!PATH!', 'x" & whoami', 'a`b', '$PATH', '--if-present']) {
    assert.throws(() => invocation('npm', name, 'win32'));
  }
});

function fixture(files) {
  return {
    readText: async file => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; },
    exists: async file => file in files
  };
}

test('Manager selection honors explicit setting, packageManager, nearest lock and workspace ancestry', async () => {
  const root = path.resolve('workspace');
  const directory = path.join(root, 'packages', 'web');
  const input = { directory, boundary: root, ...fixture({
    [path.join(root, 'package.json')]: '{"packageManager":"pnpm@10.0.0"}',
    [path.join(root, 'yarn.lock')]: ''
  }) };
  assert.equal(await detectManager({ ...input, configured: 'bun', declared: 'npm@11' }), 'bun');
  assert.equal(await detectManager({ ...input, declared: 'npm@11' }), 'npm');
  assert.equal(await detectManager(input), 'pnpm');
  assert.equal(await detectManager({ ...input, ...fixture({ [path.join(directory, 'yarn.lock')]: '' }) }), 'yarn');
  assert.equal(await detectManager({ directory, ...fixture({ [path.join(root, 'yarn.lock')]: '' }) }), 'npm');
});

test('Does not read package manager declarations outside the workspace', async () => {
  const root = path.resolve('workspace');
  const files = { [path.join(path.dirname(root), 'package.json')]: '{"packageManager":"bun@1"}' };
  assert.equal(await detectManager({ directory: root, boundary: root, ...fixture(files) }), 'npm');
  assert.notEqual(taskKey('file:///a/package.json', 'dev'), taskKey('file:///b/package.json', 'dev'));
});

test('User interrupts are separate from failures; arbitrary code 512 must not hide a genuine error', () => {
  assert.equal(completionStatus({ exitCode: 512, interrupted: true }), 'stopped');
  assert.equal(completionStatus({ exitCode: 1, requestedStop: true }), 'stopped');
  assert.equal(completionStatus({ exitCode: 512 }), 'failed');
  assert.equal(completionStatus({ exitCode: 1 }), 'failed');
  assert.equal(completionStatus({ exitCode: 130 }), 'stopped');
  assert.equal(completionStatus({ exitCode: -1073741510 }), 'stopped');
  assert.equal(completionStatus({ exitCode: 0 }), 'success');
  assert.equal(completionStatus({}), 'ended');
  assert.equal(completionStatus({ forced: true, requestedStop: true }), 'forced');
});
