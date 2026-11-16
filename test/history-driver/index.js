'use strict';
const vscode = require('vscode');

// VS Code intentionally uses in-memory storage with --extensionTestsPath.
// This development-only helper runs the persistence test with real storage in an isolated user-data-dir.
async function activate() {
  try { await require('../history.integration').run(); }
  catch (error) { console.error(error); }
  finally { setTimeout(() => void vscode.commands.executeCommand('workbench.action.closeWindow'), 500); }
}
module.exports = { activate };
