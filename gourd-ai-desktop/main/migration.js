'use strict';

const fs = require('fs');
const path = require('path');

const STAGING_DIR = '.gwork-desktop-migration';
const STAGING_NAMES = ['install-gwork', 'install-gourdai'];
const LEGACY_HOME = '.gourdai';
// Records which non-disposable sources have already been merged, so a source we
// are not allowed to delete (e.g. the read-only install directory) is not merged
// again on every launch — which would otherwise resurrect files the user deleted.
const STATE_FILE = '.desktop-migration-state.json';

function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function copyEntry(source, target) {
  const sourceStat = fs.lstatSync(source);
  if (exists(target)) {
    const targetStat = fs.lstatSync(target);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      copyDirectory(source, target, false);
    }
    // Existing target data always wins, including file/directory conflicts.
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    copyDirectory(source, target, false);
  } else if (sourceStat.isSymbolicLink()) {
    copySymlink(source, target);
  } else {
    fs.copyFileSync(source, target);
  }
}

/**
 * Symlink recreation needs SeCreateSymbolicLinkPrivilege on Windows, which a
 * normal user does not have. Never let one link abort the whole migration:
 * fall back to copying the resolved file, otherwise skip the dangling link.
 */
function copySymlink(source, target) {
  try {
    fs.symlinkSync(fs.readlinkSync(source), target, process.platform === 'win32' ? 'junction' : undefined);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOSYS') throw error;
    try {
      if (fs.statSync(source).isFile()) {
        fs.copyFileSync(source, target);
        return;
      }
    } catch (e) {
      /* dangling or unreadable link: nothing worth copying */
    }
    console.warn('[gourd-ai-desktop] 跳过无法重建的符号链接:', source);
  }
}

/**
 * @param {boolean} topLevel `bin` and the nested legacy home are only special at
 *   the root of a migration source. Skipping them at every depth would silently
 *   drop legitimate nested data such as `skills/<name>/bin`.
 */
function copyDirectory(source, target, topLevel) {
  for (const name of fs.readdirSync(source).sort()) {
    const child = path.join(source, name);
    if (topLevel) {
      // Launchers are rebuilt by cli-provision; never import an old root bin.
      if (name === 'bin') continue;
      // Historic bug wrote `.gourdai/.gourdai`; fold that payload into the root.
      if (name === LEGACY_HOME && fs.lstatSync(child).isDirectory()) {
        copyDirectory(child, target, true);
        continue;
      }
    }
    copyEntry(child, path.join(target, name));
  }
}

function readState(targetDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(targetDir, STATE_FILE), 'utf8'));
    return parsed && typeof parsed.consumed === 'object' && parsed.consumed ? parsed : { consumed: {} };
  } catch (error) {
    return { consumed: {} };
  }
}

function writeState(targetDir, state) {
  try {
    fs.writeFileSync(path.join(targetDir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    // A read-only home must not break startup; worst case we merge again later.
    console.warn('[gourd-ai-desktop] 迁移状态写入失败（不影响启动）:', error && error.message);
  }
}

/** Cheap change token: a reinstall rewrites the directory, bumping its mtime. */
function fingerprint(source) {
  try {
    return String(fs.lstatSync(source).mtimeMs);
  } catch (error) {
    return '';
  }
}

/**
 * Merge one desktop installation's data into the user's canonical ~/.gwork.
 * Sources are ordered from highest to lowest priority. The destination itself
 * is never overwritten, and all copies are real copies (never cross-root renames).
 *
 * Disposable sources (the installer staging trees) are deleted once every copy
 * has succeeded. Persistent sources — the install directory and legacy homes,
 * which we may not have permission to delete — are instead recorded in
 * `.desktop-migration-state.json` so they are merged exactly once per revision.
 *
 * @param {{homeDir: string, resourcesDir?: string, legacyRoots?: string[]}} options
 * @returns {{targetDir: string, migrated: boolean}}
 */
function migrateGlobalData({ homeDir, resourcesDir, legacyRoots = [] }) {
  if (!homeDir) throw new TypeError('homeDir is required');
  const targetDir = path.join(homeDir, '.gwork');
  const stagingRoot = path.join(homeDir, STAGING_DIR);
  const candidates = [];
  const add = (source, disposable) => {
    if (source && !candidates.some((item) => path.resolve(item.source) === path.resolve(source))) {
      candidates.push({ source, disposable });
    }
  };

  // Highest priority first: canonical .gwork (including packaged resources),
  // then nested legacy data, then outer legacy data.
  add(path.join(homeDir, '.gwork'), false);
  add(path.join(resourcesDir || '', '.gwork'), false);
  add(path.join(stagingRoot, 'install-gwork'), true);
  add(path.join(homeDir, LEGACY_HOME, LEGACY_HOME), false);
  add(path.join(resourcesDir || '', LEGACY_HOME, LEGACY_HOME), false);
  add(path.join(stagingRoot, 'install-gourdai', LEGACY_HOME), true);
  add(path.join(stagingRoot, 'install-gourdai'), true);
  add(path.join(homeDir, LEGACY_HOME), false);
  add(path.join(resourcesDir || '', LEGACY_HOME), false);

  // Explicit legacy roots (notably macOS Application Support) are migration
  // sources only. Accept either a legacy .gwork/.gourdai directory or its
  // containing installation root; the normal source ordering remains primary.
  for (const root of legacyRoots) {
    add(root, false);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const state = readState(targetDir);
  const consumed = {};
  let migrated = false;
  // Do not copy the destination onto itself; its contents already have priority.
  for (const { source, disposable } of candidates) {
    if (!exists(source) || path.resolve(source) === path.resolve(targetDir)) continue;
    const key = path.resolve(source);
    const token = disposable ? '' : fingerprint(source);
    if (!disposable && state.consumed[key] === token) continue;
    migrated = true;
    copyDirectory(source, targetDir, true);
    if (!disposable) consumed[key] = token;
  }

  // Staging is disposable only after the whole merge has completed.
  for (const name of STAGING_NAMES) {
    const staging = path.join(stagingRoot, name);
    // force:true — a read-only leftover must not turn a finished merge into a failure.
    if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
  if (Object.keys(consumed).length) {
    writeState(targetDir, { consumed: { ...state.consumed, ...consumed } });
  }
  return { targetDir, migrated };
}

module.exports = {
  STAGING_DIR,
  STAGING_NAMES,
  STATE_FILE,
  migrateGlobalData,
};
