'use strict';

const path = require('node:path');
const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']
];

function parsePackage(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Ошибка JSON в package.json: ${error.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('package.json должен содержать JSON-объект.');
  }
  if (data.scripts !== undefined && (!data.scripts || typeof data.scripts !== 'object' || Array.isArray(data.scripts))) {
    throw new Error('Поле scripts должно содержать объект с командами.');
  }
  return {
    name: typeof data.name === 'string' ? data.name : '',
    packageManager: typeof data.packageManager === 'string' ? data.packageManager : '',
    scripts: Object.entries(data.scripts || {}).map(([name, command]) => {
      if (typeof command !== 'string') throw new Error(`Команда «${name}» должна быть строкой.`);
      return { name, command };
    })
  };
}

function declaredManager(value) {
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(value || '');
  return match ? match[1] : undefined;
}

async function detectManager({ directory, boundary, declared, configured, readText, exists }) {
  if (MANAGERS.includes(configured)) return configured;
  if (declaredManager(declared)) return declaredManager(declared);
  let current = directory;
  while (true) {
    if (current !== directory) {
      try {
        const parent = JSON.parse(await readText(path.join(current, 'package.json')));
        const manager = declaredManager(parent.packageManager);
        if (manager) return manager;
      } catch { /* An ancestor without package.json is normal. */ }
    }
    for (const [lock, manager] of LOCKS) {
      if (await exists(path.join(current, lock))) return manager;
    }
    const parent = path.dirname(current);
    if (current === boundary || parent === current || !boundary) break;
    const relative = path.relative(boundary, parent);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) break;
    current = parent;
  }
  return 'npm';
}

function invocation(manager, script, platform = process.platform) {
  if (!MANAGERS.includes(manager)) throw new Error('Неизвестный менеджер пакетов.');
  // VS Code quotes each argument for the selected terminal shell. Never interpolate a script's body.
  // Shell variable expansion in cmd.exe cannot be disabled by quoting, so reject these rare names.
  if (!script || script.startsWith('-') || /[\u0000-\u001f\u007f]/.test(script) || (platform === 'win32' && /[%!"`$]/.test(script))) {
    throw new Error('Это имя скрипта нельзя безопасно передать оболочке. Используйте буквы, цифры, пробелы, «:», «-» или «_».');
  }
  const executable = platform === 'win32' ? (manager === 'bun' ? 'bun.exe' : `${manager}.cmd`) : manager;
  return { executable, args: ['run', script] };
}

function taskKey(uri, script) { return JSON.stringify([uri, script]); }

function completionStatus({ exitCode, requestedStop, interrupted, forced }) {
  if (forced) return 'forced';
  if (requestedStop || interrupted || [130, 143, -1073741510, 3221225786].includes(exitCode)) return 'stopped';
  return exitCode === 0 ? 'success' : exitCode === undefined ? 'ended' : 'failed';
}

module.exports = { parsePackage, detectManager, declaredManager, invocation, taskKey, completionStatus };
