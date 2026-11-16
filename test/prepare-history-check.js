'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const manifest = JSON.stringify({ name: 'same-project-name', scripts: {
  dev: 'node -e "console.log(123)"', build: 'node -e "console.log(456)"'
} }, null, 2);
for (const repo of ['repo-a', 'repo-b']) {
  const directory = path.join(root, repo);
  fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), manifest);
}
fs.mkdirSync(path.join(root, 'repo-a', 'packages', 'web'), { recursive: true });
fs.writeFileSync(path.join(root, 'repo-a', 'packages', 'web', 'package.json'), manifest);
fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), JSON.stringify({
  'terminal.integrated.defaultProfile.windows': 'PowerShell'
}, null, 2));
for (const name of ['history-phase1.json', 'history-result.json']) fs.rmSync(path.join(root, name), { force: true });
