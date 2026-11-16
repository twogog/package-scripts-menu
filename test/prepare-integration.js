'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), JSON.stringify({
  'terminal.integrated.defaultProfile.windows': 'PowerShell',
  'packageScriptsMenu.stopTimeout': 1,
  'task.saveBeforeRun': 'never'
}, null, 2));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'menu-integration', scripts: {
  smoke: 'node smoke.js',
  'edge & name': 'node -e "console.log(123)"',
  fail: 'node -e "process.exit(7)"',
  watch: 'node watch.js'
} }, null, 2));
fs.writeFileSync(path.join(root, 'smoke.js'), `const fs = require('node:fs');
const count = fs.existsSync('smoke-result.json') ? JSON.parse(fs.readFileSync('smoke-result.json')).count : 0;
fs.writeFileSync('smoke-result.json', JSON.stringify({ count: count + 1, cwd: process.cwd() }));
console.log('SMOKE OK');
`);
fs.writeFileSync(path.join(root, 'watch.js'), `require('node:fs').writeFileSync('watch-started', 'yes');
setInterval(() => console.log('working'), 1000);
`);
for (const name of ['smoke-result.json', 'watch-started']) {
  fs.rmSync(path.join(root, name), { force: true });
}
