'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const bashPath = process.argv[3];
fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'stop-tree.cjs'), path.join(root, 'tree.cjs'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stop-check', scripts: {
  'server:button': 'node tree.cjs button',
  'server:manual': 'node tree.cjs manual',
  'server:stubborn': 'node tree.cjs stubborn'
} }, null, 2));
const settings = { 'packageScriptsMenu.stopTimeout': 5 };
if (bashPath) {
  settings['terminal.integrated.profiles.windows'] = { 'Stop Check Bash': { path: bashPath, args: ['--login', '-i'] } };
  settings['terminal.integrated.defaultProfile.windows'] = 'Stop Check Bash';
}
fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
for (const mode of ['button', 'manual', 'stubborn']) {
  for (const role of ['launcher', 'server', 'worker']) {
    for (const suffix of ['json', 'log']) fs.rmSync(path.join(root, `${mode}-${role}.${suffix}`), { force: true });
  }
}
