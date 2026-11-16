'use strict';

const crypto = require('node:crypto');

function repositoryStorageKey(repository) {
  return `scriptHistory.v1.${crypto.createHash('sha256').update(repository).digest('hex')}`;
}

function entryKey(scope, name) { return JSON.stringify([scope.package, name]); }

function stats(value) {
  return {
    favorite: value?.favorite === true,
    runCount: Number.isSafeInteger(value?.runCount) && value.runCount > 0 ? value.runCount : 0,
    lastRun: Number.isFinite(value?.lastRun) && value.lastRun > 0 ? value.lastRun : 0
  };
}

class ScriptHistory {
  constructor(storage) {
    this.storage = storage;
    this.pending = new Map();
  }

  get(scope, name) {
    const repository = this.storage.get(repositoryStorageKey(scope.repository), {});
    return stats(repository?.[entryKey(scope, name)]);
  }

  async update(scope, name, change) {
    const storageKey = repositoryStorageKey(scope.repository);
    const key = entryKey(scope, name);
    // Serialize read/modify/write operations so a favorite click cannot overwrite a simultaneous run.
    const previous = this.pending.get(storageKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const value = this.storage.get(storageKey, {});
      const repository = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      await this.storage.update(storageKey, { ...repository, [key]: change(stats(repository[key])) });
    });
    this.pending.set(storageKey, operation);
    try { await operation; }
    finally { if (this.pending.get(storageKey) === operation) this.pending.delete(storageKey); }
  }

  setFavorite(scope, name, favorite) {
    return this.update(scope, name, current => ({ ...current, favorite: favorite === true }));
  }

  recordRun(scope, name, time = Date.now()) {
    return this.update(scope, name, current => ({ ...current,
      runCount: Math.min(Number.MAX_SAFE_INTEGER, current.runCount + 1), lastRun: time }));
  }
}

module.exports = { ScriptHistory, repositoryStorageKey };
