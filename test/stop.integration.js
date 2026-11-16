'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const canConnect = port => new Promise(resolve => {
  if (!port) return resolve(false);
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(400);
  let settled = false;
  function done(value) { if (!settled) { settled = true; socket.destroy(); resolve(value); } }
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.once('timeout', () => done(false));
});
async function until(condition, label, timeout = 20000) {
  const start = Date.now();
  while (!await condition()) {
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`);
    await wait(100);
  }
}
async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const resultPath = path.join(root, '..', 'stop-check-result.json');
  const records = [];
  const report = { cases: [] };
  const processIds = new Map();
  const subscription = vscode.tasks.onDidStartTaskProcess(event => {
    if (event.execution.task.definition.type === 'package-scripts-menu') {
      processIds.set(event.execution.task.definition.script, event.processId);
    }
  });
  try {
    const manifest = require('../package.json');
    const menu = await vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`).activate();
    const uri = vscode.Uri.file(path.join(root, 'package.json'));
    await menu.open(uri);
    for (const mode of ['button', 'manual', 'stubborn']) {
      const script = `server:${mode}`;
      await menu.run(uri, script);
      const entries = [];
      for (const role of ['launcher', 'server', 'worker']) {
        let entry;
        await until(async () => {
          try { entry = JSON.parse(await fs.readFile(path.join(root, `${mode}-${role}.json`), 'utf8')); return true; }
          catch { return false; }
        }, `${mode} ${role} starts`);
        entries.push(entry);
        records.push(entry);
      }
      const portsBefore = await Promise.all(entries.filter(entry => entry.port).map(entry => canConnect(entry.port)));
      if (portsBefore.some(value => !value)) throw new Error('Expected test servers to listen before stopping');
      await wait(300);
      if (entries.some(entry => !alive(entry.pid))) throw new Error('A test process exited before the stop request');
      const taskPid = processIds.get(script);
      let terminal;
      for (const item of vscode.window.terminals) {
        if (await item.processId === taskPid) terminal = item;
      }
      if (!terminal) throw new Error(`Cannot find exact task terminal for PID ${taskPid}`);
      await until(() => menu.jobs.get(JSON.stringify([uri.toString(), script]))?.terminal === terminal, 'extension attaches correct terminal');
      const started = Date.now();
      const key = JSON.stringify([uri.toString(), script]);
      if (mode !== 'manual') await menu.stop(uri, script);
      else {
        terminal.show(false);
        await until(() => vscode.window.activeTerminal === terminal, 'manual task is active');
        await vscode.commands.executeCommand('packageScriptsMenu.interruptTerminal');
        await until(() => entries.every(entry => !alive(entry.pid)), 'Ctrl+C closes test servers');
        // On Windows npm.cmd may ask to terminate a batch job. Simulate answering its prompt.
        if (['starting', 'running', 'stopping'].includes(menu.jobs.get(key)?.status)) terminal.sendText('y', true);
      }
      let ended = true;
      try { await until(() => !['starting', 'running', 'stopping'].includes(menu.jobs.get(key)?.status), 'task ends', 10000); }
      catch { ended = false; }
      const elapsed = Date.now() - started;
      try { await until(() => entries.every(entry => !alive(entry.pid)), 'all tracked test processes exit', 4000); } catch { }
      const after = [];
      for (const entry of entries) {
        after.push({ ...entry, alive: alive(entry.pid), listening: await canConnect(entry.port),
          events: await fs.readFile(path.join(root, `${mode}-${entry.role}.log`), 'utf8').catch(() => '') });
      }
      const job = menu.jobs.get(key);
      report.cases.push({ mode, ended, elapsedMs: elapsed, status: job.status, exitCode: job.exitCode,
        taskPid, shell: terminal.creationOptions.shellPath, processes: after });
      if (['starting', 'running', 'stopping'].includes(job.status)) job.execution?.terminate();
      assert.equal(ended, true, `${mode}: task must finish`);
      assert.ok(after.every(entry => !entry.alive && !entry.listening), `${mode}: no processes or listening ports may remain`);
      if (mode === 'manual') assert.equal(job.status, 'stopped');
      if (mode === 'stubborn') {
        assert.equal(job.status, 'forced');
        assert.ok(elapsed >= 4500, 'force fallback must wait for the grace timeout');
      } else assert.ok(after.every(entry => entry.events.includes('cleanup finished')), `${mode}: every child must complete cleanup`);
    }
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.stack; throw error; }
  finally {
    subscription.dispose();
    await fs.writeFile(resultPath, JSON.stringify(report, null, 2));
    for (const entry of records) {
      if (alive(entry.pid)) await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    }
  }
}
module.exports = { run };
