'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  const labels = { idle: '', starting: 'Запускается…', running: 'Работает', stopping: 'Останавливается…',
    stopped: 'Остановлен', forced: 'Остановлен принудительно', success: 'Завершён', failed: 'Ошибка', ended: 'Завершён' };
  const saved = vscode.getState() || {};
  const views = saved.views || {};
  const filters = Array.from(document.querySelectorAll('[data-filter]'));
  let activeFilter = 'all';
  let model;
  const running = status => ['starting', 'running', 'stopping'].includes(status);

  function send(type, script, extra = {}) {
    vscode.postMessage({ type, uri: model?.uri, name: script?.name, command: script?.command, ...extra });
  }

  function saveView() {
    if (!model?.uri) return;
    views[model.uri] = { search: element('search').value, filter: activeFilter };
    vscode.setState({ views });
  }

  function render() {
    if (!model) return;
    element('project').textContent = model.name || 'Скрипты проекта';
    element('path').textContent = model.path || '';
    element('manager').textContent = model.manager || '';
    element('error').hidden = !model.error;
    element('error').textContent = model.error || '';
    const notices = [];
    if (model.trusted === false) notices.push('Запуск доступен только в доверенной папке проекта.');
    if (model.dirty) notices.push('Перед запуском изменения package.json будут сохранены.');
    element('notice').hidden = notices.length === 0;
    element('notice').textContent = notices.join(' ');
    const search = element('search').value.toLocaleLowerCase();
    let scripts = (model.scripts || []).filter(script => `${script.name} ${script.command}`.toLocaleLowerCase().includes(search));
    if (activeFilter === 'favorites') scripts = scripts.filter(script => script.favorite);
    if (activeFilter === 'frequent') {
      scripts = scripts.filter(script => script.runCount > 0).sort((a, b) => b.runCount - a.runCount || b.lastRun - a.lastRun);
    }
    for (const filter of filters) filter.setAttribute('aria-pressed', String(filter.dataset.filter === activeFilter));
    element('count').textContent = `${scripts.length} / ${model.scripts?.length || 0}`;
    const list = element('list');
    // Build DOM with textContent: package.json is data, never HTML or JavaScript.
    const activeName = document.activeElement?.dataset.script;
    const activeAction = document.activeElement?.dataset.action;
    list.replaceChildren();
    for (const script of scripts) {
      const row = document.createElement('article');
      row.className = `script ${script.status}`;
      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = `favorite${script.favorite ? ' selected' : ''}`;
      favorite.textContent = script.favorite ? '★' : '☆';
      favorite.title = script.favorite ? 'Убрать из избранного' : 'Добавить в избранное';
      favorite.dataset.script = script.name;
      favorite.dataset.action = 'favorite';
      favorite.setAttribute('aria-label', `${favorite.title}: ${script.name}`);
      favorite.setAttribute('aria-pressed', String(script.favorite));
      favorite.addEventListener('click', () => {
        favorite.disabled = true;
        send('favorite', script, { favorite: !script.favorite });
      });
      const top = document.createElement('div');
      top.className = 'script-top';
      const label = document.createElement('div');
      label.className = 'script-label';
      const title = document.createElement('h2');
      title.textContent = script.name;
      const info = document.createElement('span');
      info.className = 'script-info';
      info.textContent = 'i';
      info.title = script.command || '(пустая команда)';
      info.setAttribute('role', 'img');
      info.setAttribute('aria-label', `Подробная команда: ${info.title}`);
      label.append(title, info);
      if (script.runCount > 0) {
        const usage = document.createElement('span');
        usage.className = 'usage';
        usage.textContent = `${script.runCount}×`;
        usage.title = `Запусков из меню: ${script.runCount}`;
        usage.setAttribute('aria-label', usage.title);
        label.append(usage);
      }
      const status = document.createElement('span');
      status.className = 'status';
      status.setAttribute('role', 'status');
      status.textContent = labels[script.status] + (typeof script.exitCode === 'number' && script.exitCode !== 0 && !['stopped', 'forced'].includes(script.status) ? ` · код ${script.exitCode}` : '');
      top.append(label, status);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.script = script.name;
      button.dataset.action = 'run';
      const busy = running(script.status);
      button.className = busy ? 'secondary stop' : 'run';
      button.textContent = busy ? '■ Остановить' : '▶ Запустить';
      button.disabled = script.status === 'stopping' || model.trusted === false;
      button.setAttribute('aria-label', `${busy ? 'Остановить' : 'Запустить'} ${script.name}`);
      button.addEventListener('click', () => {
        button.disabled = true;
        send(busy ? 'stop' : 'run', script);
      });
      row.append(favorite, top, button);
      list.append(row);
      if (activeName === script.name) {
        (activeAction === 'favorite' ? favorite : button).focus({ preventScroll: true });
      }
    }
    element('empty').hidden = Boolean(scripts.length) || Boolean(model.error);
    element('empty').textContent = !model.scripts?.length
      ? 'В этом package.json нет скриптов. Добавьте команды в поле "scripts", например: "dev": "vite".'
      : search ? 'По вашему запросу ничего не найдено.'
      : activeFilter === 'favorites' ? 'Нажмите ☆ рядом с командой, чтобы добавить её в избранное.'
      : 'Здесь появятся команды, которые вы запускаете из этого меню.';
  }

  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    if (model?.uri !== event.data.model.uri) {
      const view = views[event.data.model.uri] || {};
      element('search').value = view.search || '';
      activeFilter = ['all', 'favorites', 'frequent'].includes(view.filter) ? view.filter : 'all';
    }
    model = event.data.model;
    render();
  });
  element('search').addEventListener('input', () => {
    saveView();
    render();
  });
  for (const filter of filters) filter.addEventListener('click', () => {
    activeFilter = filter.dataset.filter;
    saveView();
    render();
  });
  element('refresh').addEventListener('click', () => send('refresh'));
  element('source').addEventListener('click', () => send('source'));
  send('ready');
})();
