'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { repositoryStorageKey } = require('../src/history');
const { taskKey } = require('../src/core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > 20000) throw new Error(`Timeout: ${label}`);
    await wait(100);
  }
}
async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const marker = path.join(root, 'history-phase1.json');
  const result = path.join(root, 'history-result.json');
  const checks = [];
  try {
    const manifest = require('../package.json');
    const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    const menu = await extension.activate();
    const a = vscode.Uri.file(path.join(root, 'repo-a', 'package.json'));
    const b = vscode.Uri.file(path.join(root, 'repo-b', 'package.json'));
    const nested = vscode.Uri.file(path.join(root, 'repo-a', 'packages', 'web', 'package.json'));
    const scopeA = await menu.historyScope(a);
    const scopeB = await menu.historyScope(b);
    const scopeNested = await menu.historyScope(nested);
    assert.notEqual(scopeA.repository, scopeB.repository);
    assert.equal(scopeA.repository, scopeNested.repository);
    assert.notEqual(scopeA.package, scopeNested.package);
    const script = (model, name) => model.scripts.find(item => item.name === name);
    const restoring = await fs.stat(marker).then(() => true, () => false);
    if (restoring) {
      const modelA = await menu.readModel(a);
      const modelB = await menu.readModel(b);
      assert.equal(script(modelA, 'build').favorite, true);
      assert.equal(script(modelA, 'dev').runCount, 2);
      assert.equal(script(modelB, 'dev').favorite, true);
      assert.equal(script(modelB, 'build').runCount, 1);
      assert.equal(script(modelB, 'dev').runCount, 0);
      assert.equal(script(await menu.readModel(nested), 'build').favorite, false);
      checks.push('Favorites and counters survive a real VS Code window restart');
      checks.push('Different repositories and nested package.json files remain isolated after restart');
      await menu.open(a);
      await menu.onMessage({ type: 'favorite', uri: a.toString(), name: 'build', favorite: false });
      assert.equal(script(await menu.readModel(a), 'build').favorite, false);
      assert.equal(script(await menu.readModel(b), 'dev').favorite, true);
      checks.push('Removing a favorite only changes the selected repository');
      await fs.writeFile(result, JSON.stringify({ ok: true, phase: 'restored', checks }, null, 2));
      return;
    }
    await menu.context.globalState.update(repositoryStorageKey(scopeA.repository), undefined);
    await menu.context.globalState.update(repositoryStorageKey(scopeB.repository), undefined);
    await menu.open(a);
    await menu.onMessage({ type: 'favorite', uri: a.toString(), name: 'build', favorite: true });
    assert.equal(script(menu.model, 'build').favorite, true);
    await menu.run(a, 'dev');
    await until(() => menu.jobs.get(taskKey(a.toString(), 'dev'))?.status === 'success', 'first dev run');
    await menu.run(a, 'dev');
    await until(() => menu.jobs.get(taskKey(a.toString(), 'dev'))?.status === 'success', 'second dev run');
    assert.equal(script(await menu.readModel(a), 'dev').runCount, 2);
    checks.push('Actual launches update frequency and favorite changes persist');
    await menu.open(b);
    assert.ok(menu.model.scripts.every(item => !item.favorite && item.runCount === 0));
    await menu.onMessage({ type: 'favorite', uri: b.toString(), name: 'dev', favorite: true });
    await menu.run(b, 'build');
    await until(() => menu.jobs.get(taskKey(b.toString(), 'build'))?.status === 'success', 'repo B build');
    assert.equal(script(await menu.readModel(b), 'build').runCount, 1);
    const back = await menu.readModel(a);
    assert.equal(script(back, 'build').favorite, true);
    assert.equal(script(back, 'dev').favorite, false);
    assert.equal(script(back, 'dev').runCount, 2);
    assert.ok((await menu.readModel(nested)).scripts.every(item => !item.favorite && item.runCount === 0));
    checks.push('Identical project and script names in two repositories do not share history');
    checks.push('Nested manifests in a monorepo have distinct commands');
    await fs.writeFile(marker, JSON.stringify({ ok: true, checks }, null, 2));
    await fs.writeFile(result, JSON.stringify({ ok: true, phase: 'seeded', checks }, null, 2));
  } catch (error) {
    await fs.writeFile(result, JSON.stringify({ ok: false, checks, error: error.stack }, null, 2));
    throw error;
  }
}
module.exports = { run };
