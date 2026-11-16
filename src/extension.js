'use strict';

const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { parsePackage, detectManager, invocation, taskKey, completionStatus } = require('./core');
const { ScriptHistory } = require('./history');
const TASK_TYPE = 'package-scripts-menu';
const isPackage = uri => uri && ['file', 'vscode-remote'].includes(uri.scheme) && path.posix.basename(uri.path) === 'package.json';
const isRunning = item => item && ['starting', 'running', 'stopping'].includes(item.status);

class ScriptsMenu {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.uri = undefined;
    this.model = undefined;
    this.jobs = new Map();
    this.history = new ScriptHistory(context.globalState);
    this.historyScopes = new Map();
    this.sequence = 0;
    this.lastEditor = undefined;
    this.disposables = [
      vscode.commands.registerCommand('packageScriptsMenu.open', uri => this.guard(() => this.open(uri))),
      vscode.commands.registerCommand('packageScriptsMenu.interruptTerminal', () => this.interruptActiveTerminal()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.onEditor(editor)),
      vscode.window.onDidChangeActiveTerminal(() => this.updateTerminalContext()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === this.uri?.toString()) this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === this.uri?.toString()) this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('packageScriptsMenu')) this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.historyScopes.clear(); void this.refresh(); }),
      vscode.tasks.onDidStartTask(event => this.startTask(event.execution)),
      vscode.tasks.onDidStartTaskProcess(event => void this.attachTerminal(event.execution, event.processId)),
      vscode.tasks.onDidEndTaskProcess(event => this.finishTask(event.execution, event.exitCode)),
      vscode.tasks.onDidEndTask(event => this.finishTask(event.execution))
    ];
    this.updateTerminalContext();
    this.onEditor(vscode.window.activeTextEditor);
  }

  async guard(action) {
    try { return await action(); }
    catch (error) { await vscode.window.showErrorMessage(`Package Scripts: ${error.message}`); }
  }

  onEditor(editor) {
    if (!editor) return;
    const uri = editor.document.uri;
    const key = uri.toString();
    if (key === this.lastEditor) return;
    this.lastEditor = key;
    if (isPackage(uri) && vscode.workspace.getConfiguration('packageScriptsMenu', uri).get('autoOpen', true)) {
      void this.guard(() => this.open(uri, true));
    }
  }

  async pickPackage() {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (isPackage(active)) return active;
    if (isPackage(this.uri)) return this.uri;
    const files = await vscode.workspace.findFiles('**/package.json', '**/{node_modules,.git,.yarn,dist,build}/**', 100);
    if (!files.length) throw new Error('Откройте package.json или папку проекта в VS Code.');
    if (files.length === 1) return files[0];
    const item = await vscode.window.showQuickPick(files.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), {
      placeHolder: 'Выберите package.json'
    });
    return item?.uri;
  }

  async open(candidate, preserveFocus = false) {
    const uri = isPackage(candidate) ? candidate : await this.pickPackage();
    if (!uri) return;
    this.uri = uri;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('packageScriptsMenu', 'Скрипты package.json', {
        viewColumn: vscode.ViewColumn.Beside, preserveFocus
      }, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        retainContextWhenHidden: true
      });
      this.panel.webview.onDidReceiveMessage(message => void this.guard(() => this.onMessage(message)), null, this.disposables);
      this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
      this.panel.webview.html = this.html(this.panel.webview);
    } else {
      this.panel.reveal(this.panel.viewColumn, preserveFocus);
    }
    await this.refresh();
  }

  async readModel(uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    const parsed = parsePackage(document.getText());
    const directory = path.dirname(uri.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const toUri = file => uri.with({ path: path.posix.join(path.posix.dirname(uri.path), path.relative(directory, file).split(path.sep).join('/')) });
    const manager = await detectManager({
      directory,
      boundary: folder?.uri.fsPath,
      declared: parsed.packageManager,
      configured: vscode.workspace.getConfiguration('packageScriptsMenu', uri).get('packageManager', 'auto'),
      readText: async file => Buffer.from(await vscode.workspace.fs.readFile(toUri(file))).toString('utf8'),
      exists: async file => { try { await vscode.workspace.fs.stat(toUri(file)); return true; } catch { return false; } }
    });
    const scope = await this.historyScope(uri);
    return {
      uri: uri.toString(),
      name: parsed.name || path.basename(directory),
      path: vscode.workspace.asRelativePath(uri, true),
      manager,
      dirty: document.isDirty,
      trusted: vscode.workspace.isTrusted,
      scripts: parsed.scripts.map(script => {
        const job = this.jobs.get(taskKey(uri.toString(), script.name));
        return { ...script, ...this.history.get(scope, script.name), status: job?.status || 'idle', exitCode: job?.exitCode };
      })
    };
  }

  historyScope(uri) {
    const key = uri.toString();
    if (!this.historyScopes.has(key)) this.historyScopes.set(key, this.resolveHistoryScope(uri));
    return this.historyScopes.get(key);
  }

  async resolveHistoryScope(uri) {
    const packageDirectory = vscode.Uri.joinPath(uri, '..');
    let directory = packageDirectory;
    let repository;
    while (true) {
      try {
        // .git may be a directory or a file in a submodule/worktree.
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, '.git'));
        repository = directory;
        break;
      } catch { /* Try the parent without running any git commands. */ }
      const parent = vscode.Uri.joinPath(directory, '..');
      if (parent.path === directory.path || /^\/[a-zA-Z]:\/?$/.test(directory.path)) break;
      directory = parent;
    }
    repository ||= vscode.workspace.getWorkspaceFolder(uri)?.uri || packageDirectory;
    let repositoryKey = repository.toString();
    let packageKey = path.posix.relative(repository.path, uri.path);
    if (process.platform === 'win32' && uri.scheme === 'file') {
      repositoryKey = repository.with({ path: repository.path.toLowerCase(), authority: repository.authority.toLowerCase() }).toString();
      packageKey = packageKey.toLowerCase();
    }
    return { repository: repositoryKey, package: packageKey };
  }

  async setFavorite(uri, name, favorite) {
    if (typeof name !== 'string' || typeof favorite !== 'boolean') return;
    const model = await this.readModel(uri);
    if (!model.scripts.some(script => script.name === name)) return;
    try { await this.history.setFavorite(await this.historyScope(uri), name, favorite); }
    finally { await this.refresh(); }
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 180);
  }

  async refresh() {
    if (!this.panel || !this.uri) return;
    const revision = ++this.sequence;
    const uri = this.uri;
    let model;
    try { model = await this.readModel(uri); }
    catch (error) { model = { uri: uri.toString(), error: error.message, scripts: [] }; }
    if (revision !== this.sequence || !this.panel) return;
    this.model = model;
    this.panel.title = model.name ? `Скрипты: ${model.name}` : 'Скрипты package.json';
    await this.panel.webview.postMessage({ type: 'state', model });
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' || message.type === 'refresh') return this.refresh();
    if (message.uri !== this.uri?.toString()) return;
    if (message.type === 'run') return this.run(this.uri, message.name, message.command);
    if (message.type === 'stop') return this.stop(this.uri, message.name);
    if (message.type === 'favorite') return this.setFavorite(this.uri, message.name, message.favorite);
    if (message.type === 'source') {
      const document = await vscode.workspace.openTextDocument(this.uri);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    }
  }

  async run(uri, name, displayedCommand) {
    if (!isPackage(uri) || typeof name !== 'string') throw new Error('Выберите скрипт из package.json.');
    if (!vscode.workspace.isTrusted) throw new Error('Для запуска скриптов откройте доверенную папку проекта.');
    const key = taskKey(uri.toString(), name);
    if (isRunning(this.jobs.get(key))) return;
    // Reserve before any await: rapid double clicks must never launch two copies.
    const job = { status: 'starting' };
    this.jobs.set(key, job);
    void this.refresh();
    try {
      const model = await this.readModel(uri);
      const script = model.scripts.find(item => item.name === name);
      if (!script) throw new Error(`Скрипт «${name}» отсутствует в package.json.`);
      if (displayedCommand !== undefined && displayedCommand !== script.command) {
        throw new Error('Команда изменилась. Проверьте обновлённое меню и нажмите «Запустить» ещё раз.');
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty && !await document.save()) throw new Error('Не удалось сохранить package.json. Запуск отменён.');
      // A formatter or save hook can change scripts during save. Re-check the command actually on disk.
      const saved = await this.readModel(uri);
      if (saved.scripts.find(item => item.name === name)?.command !== script.command) {
        throw new Error('Команда изменилась при сохранении. Проверьте меню и повторите запуск.');
      }
      const command = invocation(saved.manager, name);
      if (job.stopRequested) { job.status = 'stopped'; return; }
      const execution = new vscode.ShellExecution(command.executable, command.args.map(value => ({
        value, quoting: vscode.ShellQuoting.Strong
      })), { cwd: path.dirname(uri.fsPath) });
      const task = new vscode.Task({ type: TASK_TYPE, packageUri: uri.toString(), script: name },
        vscode.workspace.getWorkspaceFolder(uri) || vscode.TaskScope.Global,
        `${name} · ${saved.name}`, 'Package Scripts', execution, []);
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Dedicated,
        focus: false,
        clear: true,
        showReuseMessage: false
      };
      job.execution = await vscode.tasks.executeTask(task);
      if (job.status === 'starting') job.status = 'running';
      if (job.forceRequested && isRunning(job)) { job.forced = true; job.execution.terminate(); }
      else if (job.stopRequested) this.sendInterrupt(job);
      try { await this.history.recordRun(await this.historyScope(uri), name); }
      catch { void vscode.window.showWarningMessage('Команда запущена, но не удалось сохранить её счётчик запусков.'); }
    } catch (error) {
      job.status = 'failed';
      throw error;
    } finally {
      if (!isRunning(job)) clearTimeout(job.stopTimer);
      this.updateTerminalContext();
      await this.refresh();
    }
  }

  async stop(uri, name) {
    const job = this.jobs.get(taskKey(uri.toString(), name));
    if (!isRunning(job) || job.status === 'stopping') return;
    job.status = 'stopping';
    job.stopRequested = true;
    this.sendInterrupt(job);
    const seconds = vscode.workspace.getConfiguration('packageScriptsMenu', uri).get('stopTimeout', 30);
    job.stopTimer = setTimeout(() => {
      if (this.jobs.get(taskKey(uri.toString(), name)) !== job || !isRunning(job)) return;
      job.forceRequested = true;
      if (job.execution) { job.forced = true; job.execution.terminate(); }
    }, Math.min(60, Math.max(1, seconds)) * 1000);
    await this.refresh();
  }

  sendInterrupt(job) {
    if (!job.terminal || job.interruptSent) return;
    try {
      job.terminal.sendText('\x03', false);
      job.interruptSent = true;
    } catch { /* The bounded timeout will terminate a terminal that is no longer usable. */ }
  }

  async attachTerminal(execution, processId) {
    const definition = execution.task.definition;
    if (definition.type !== TASK_TYPE) return;
    const job = this.jobs.get(taskKey(definition.packageUri, definition.script));
    if (!isRunning(job) || job.execution !== execution) return;
    const candidates = await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
    if (!isRunning(job) || job.execution !== execution) return;
    // TaskProcessStartEvent identifies the task's shell. Never guess a terminal by its display name.
    job.terminal = candidates.find(candidate => candidate.pid === processId)?.terminal;
    if (job.stopRequested) this.sendInterrupt(job);
    this.updateTerminalContext();
  }

  updateTerminalContext() {
    const terminal = vscode.window.activeTerminal;
    const active = Boolean(terminal && [...this.jobs.values()].some(job => isRunning(job) && job.terminal === terminal));
    if (active === this.terminalContext) return;
    this.terminalContext = active;
    void vscode.commands.executeCommand('setContext', 'packageScriptsMenu.terminalRunning', active);
  }

  interruptActiveTerminal() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) return;
    const job = [...this.jobs.values()].find(item => isRunning(item) && item.terminal === terminal);
    // Preserve Ctrl+C itself. Only remember the intent for this exact task terminal, not arbitrary exit codes.
    if (job) job.interruptedUntil = Date.now() + 30000;
    terminal.sendText('\x03', false);
  }

  startTask(execution) {
    const definition = execution.task.definition;
    if (definition.type !== TASK_TYPE) return;
    const job = this.jobs.get(taskKey(definition.packageUri, definition.script));
    if (isRunning(job) && !job.execution) job.execution = execution;
  }

  finishTask(execution, exitCode) {
    const definition = execution.task.definition;
    if (definition.type !== TASK_TYPE) return;
    const job = this.jobs.get(taskKey(definition.packageUri, definition.script));
    if (!isRunning(job) || job.execution !== execution) return;
    clearTimeout(job.stopTimer);
    job.status = completionStatus({ exitCode, requestedStop: job.stopRequested,
      interrupted: job.interruptedUntil >= Date.now(), forced: job.forced });
    job.exitCode = exitCode;
    this.updateTerminalContext();
    void this.refresh();
  }

  html(webview) {
    const nonce = crypto.randomBytes(18).toString('base64');
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('menu.css')}"><title>Скрипты package.json</title></head>
<body><main>
<header><div class="eyebrow">PACKAGE SCRIPTS <span id="manager" class="badge"></span></div>
<h1 id="project">Скрипты проекта</h1><p id="path" class="path"></p>
<div class="toolbar"><button id="source" class="secondary">Открыть JSON</button><button id="refresh" class="secondary">Обновить</button><span id="count" class="count"></span></div></header>
<label class="search"><span>Поиск скриптов</span><input id="search" type="search" placeholder="Название или команда…" autocomplete="off"></label>
<div class="filters" role="group" aria-label="Показать команды">
<button type="button" class="filter" data-filter="all" aria-pressed="true">Все</button>
<button type="button" class="filter" data-filter="favorites" aria-pressed="false">Избранное</button>
<button type="button" class="filter" data-filter="frequent" aria-pressed="false">Часто запускаемые</button>
</div>
<p id="notice" class="notice" hidden></p><p id="error" class="error" role="alert" hidden></p>
<div id="list" aria-label="Скрипты проекта"></div>
<p id="empty" class="empty" hidden></p>
<footer>Вывод команд появится во встроенном терминале VS Code.</footer>
</main><script nonce="${nonce}" src="${asset('menu.js')}"></script></body></html>`;
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    for (const job of this.jobs.values()) clearTimeout(job.stopTimer);
    void vscode.commands.executeCommand('setContext', 'packageScriptsMenu.terminalRunning', false);
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function activate(context) {
  const menu = new ScriptsMenu(context);
  context.subscriptions.push(menu);
  return menu;
}

module.exports = { activate };
