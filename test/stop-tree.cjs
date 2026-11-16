'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
const role = process.argv[3] || 'launcher';
const recordPath = path.join(__dirname, `${mode}-${role}.json`);
const logPath = path.join(__dirname, `${mode}-${role}.log`);
let server;
let ending = false;
function log(message) { fs.appendFileSync(logPath, `${Date.now()} ${message}\n`); }
function record(port) { fs.writeFileSync(recordPath, JSON.stringify({ pid: process.pid, role, port })); }
function child(nextRole) { spawn(process.execPath, [__filename, mode, nextRole], { stdio: 'inherit', windowsHide: true }); }
log('started');
if (role === 'launcher') {
  record();
  child('server');
  setInterval(() => {}, 1000);
} else {
  server = net.createServer(socket => { socket.on('error', () => {}); socket.end(); });
  server.listen(0, '127.0.0.1', () => {
    record(server.address().port);
    if (role === 'server') child('worker');
  });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    if (mode === 'stubborn' && signal === 'SIGINT') { log('SIGINT ignored'); return; }
    if (ending) return;
    ending = true;
    log(signal);
    const done = () => setTimeout(() => { log('cleanup finished'); process.exit(0); }, 400);
    if (server) server.close(done); else done();
  });
}
process.on('exit', code => log(`exit ${code}`));
