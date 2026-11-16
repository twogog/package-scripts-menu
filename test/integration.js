'use strict';

// Runs in the real VS Code Extension Host; no extra npm packages are required.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { taskKey } = require('../src/core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition, description, timeout = 20000) {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > timeout) throw new Error(`Timeout: ${description}`);
    await wait(100);
  }
}

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const resultPath = path.join(root, '..', 'integration-result.json');
  const checks = [];
  try {
    const manifest = require('../package.json');
    const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    assert.ok(extension, 'extension discovered');
    const menu = await extension.activate();
    let webviewReady = false;
    const receive = menu.onMessage.bind(menu);
    menu.onMessage = message => {
      if (message?.type === 'ready') webviewReady = true;
      return receive(message);
    };
    const uri = vscode.Uri.file(path.join(root, 'package.json'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await until(() => menu.model?.scripts?.length === 4, 'automatic package menu');
    assert.ok(menu.panel, 'webview created automatically');
    await until(() => webviewReady, 'webview JavaScript loads and sends its ready event');
    assert.equal(menu.model.manager, 'npm');
    checks.push('Opening package.json automatically opens the scripts menu');

    await menu.onMessage({ type: 'run', uri: uri.toString(), name: 'smoke', command: 'outdated command' }).then(
      () => assert.fail('stale command must be rejected'), error => assert.match(error.message, /изменилась/));
    assert.equal(await fs.stat(path.join(root, 'smoke-result.json')).then(() => true, () => false), false);
    checks.push('Stale webview commands cannot run');

    const smoke = menu.model.scripts.find(script => script.name === 'smoke');
    await Promise.all([
      menu.onMessage({ type: 'run', uri: uri.toString(), name: smoke.name, command: smoke.command }),
      menu.onMessage({ type: 'run', uri: uri.toString(), name: smoke.name, command: smoke.command })
    ]);
    await until(() => menu.jobs.get(taskKey(uri.toString(), 'smoke'))?.status === 'success', 'npm task completion');
    const actual = JSON.parse(await fs.readFile(path.join(root, 'smoke-result.json'), 'utf8'));
    assert.equal(actual.cwd.toLocaleLowerCase(), root.toLocaleLowerCase());
    assert.equal(actual.count, 1, 'rapid double-click starts one process');
    checks.push('Run button starts npm in the package directory with spaces and Cyrillic; double-click is deduplicated');

    await menu.run(uri, 'edge & name', menu.model.scripts.find(script => script.name === 'edge & name').command);
    await until(() => menu.jobs.get(taskKey(uri.toString(), 'edge & name'))?.status === 'success', 'quoted script name');
    checks.push('Script names containing spaces and & are passed as one shell argument');

    await menu.run(uri, 'fail');
    await until(() => menu.jobs.get(taskKey(uri.toString(), 'fail'))?.status === 'failed', 'nonzero task exit');
    // PowerShell normalizes a native nonzero exit to 1; the task's exit code is the authoritative one.
    assert.ok(menu.jobs.get(taskKey(uri.toString(), 'fail')).exitCode > 0);
    checks.push('Nonzero exit status is shown with the exit code');

    await menu.run(uri, 'watch');
    await until(() => fs.stat(path.join(root, 'watch-started')).then(() => true, () => false), 'watch process starts');
    await menu.stop(uri, 'watch');
    await until(() => ['stopped', 'forced'].includes(menu.jobs.get(taskKey(uri.toString(), 'watch'))?.status), 'stop task');
    checks.push('Stop button terminates the actual long-running task');

    const content = document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(content.length)), '{');
    await vscode.workspace.applyEdit(edit);
    await menu.refresh();
    assert.match(menu.model.error, /JSON/);
    assert.deepEqual(menu.model.scripts, []);
    const restore = new vscode.WorkspaceEdit();
    restore.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content + '\n');
    await vscode.workspace.applyEdit(restore);
    await menu.refresh();
    assert.equal(menu.model.dirty, true);
    await menu.run(uri, 'smoke', smoke.command);
    await until(() => menu.jobs.get(taskKey(uri.toString(), 'smoke'))?.status === 'success', 'repeat run after editing');
    assert.equal(document.isDirty, false);
    checks.push('Invalid JSON disables the list; edited package.json is saved before a new run');

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    menu.panel.dispose();
    await vscode.window.showTextDocument(document);
    await until(() => menu.panel, 'reopen on package selection');
    checks.push('Menu reopens after switching back to package.json');
    menu.panel.dispose();
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, checks }, null, 2));
    console.log(checks.join('\n'));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, checks, error: error.stack }, null, 2));
    throw error;
  }
}

module.exports = { run };
