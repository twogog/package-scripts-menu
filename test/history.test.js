'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScriptHistory } = require('../src/history');

function storage() {
  const values = new Map();
  return {
    get: (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback),
    update: async (key, value) => { await new Promise(resolve => setTimeout(resolve, 2)); values.set(key, structuredClone(value)); }
  };
}

test('Favorites and counters are separate for repositories and manifests with identical script names', async () => {
  const history = new ScriptHistory(storage());
  const a = { repository: 'file:///repo-a', package: 'package.json' };
  const b = { repository: 'file:///repo-b', package: 'package.json' };
  const nested = { repository: a.repository, package: 'packages/web/package.json' };
  await history.setFavorite(a, 'dev', true);
  await history.recordRun(a, 'dev', 100);
  await history.recordRun(b, 'dev', 200);
  assert.deepEqual(history.get(a, 'dev'), { favorite: true, runCount: 1, lastRun: 100 });
  assert.deepEqual(history.get(b, 'dev'), { favorite: false, runCount: 1, lastRun: 200 });
  assert.deepEqual(history.get(nested, 'dev'), { favorite: false, runCount: 0, lastRun: 0 });
});

test('Concurrent favorites and run updates preserve every launch', async () => {
  const history = new ScriptHistory(storage());
  const scope = { repository: 'file:///repo-a', package: 'package.json' };
  await Promise.all([
    history.setFavorite(scope, 'dev', true),
    ...Array.from({ length: 12 }, (_, index) => history.recordRun(scope, 'dev', 100 + index))
  ]);
  assert.deepEqual(history.get(scope, 'dev'), { favorite: true, runCount: 12, lastRun: 111 });
  await history.setFavorite(scope, 'dev', false);
  assert.equal(history.get(scope, 'dev').runCount, 12);
});

test('Recreating the history object restores the persisted data without a running task', async () => {
  const state = storage();
  const scope = { repository: 'vscode-remote://host/repo', package: 'package.json' };
  const history = new ScriptHistory(state);
  await history.setFavorite(scope, '__proto__', true);
  await history.recordRun(scope, '__proto__', 500);
  const restored = new ScriptHistory(state);
  assert.deepEqual(restored.get(scope, '__proto__'), { favorite: true, runCount: 1, lastRun: 500 });
  assert.equal(restored.get({ ...scope, repository: 'vscode-remote://other-host/repo' }, '__proto__').favorite, false);
});
