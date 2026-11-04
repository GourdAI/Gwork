'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { migrateGlobalData, STATE_FILE } = require('../main/migration');
const { getRuntimeHomeDirFor, resolveUserHome } = require('../main/runtime-paths');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gwork-migration-')); }
function put(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function read(root, name) { return fs.readFileSync(path.join(root, name), 'utf8'); }
function has(root, name) { return fs.existsSync(path.join(root, name)); }

test('runtime base is always userHome, and a missing home fails loudly', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const isPackaged of [true, false]) {
      assert.equal(getRuntimeHomeDirFor({ platform, isPackaged, userHome: '/home/test-user', resourcesDir: '/resources', macAppData: '/legacy' }), '/home/test-user');
    }
  }
  // Silently returning undefined would produce an "undefined/.gwork" global area.
  assert.throws(() => getRuntimeHomeDirFor({}), TypeError);
  assert.throws(() => getRuntimeHomeDirFor(), TypeError);
});

test('user home resolution order is fixed per platform', () => {
  const env = { USERPROFILE: 'C:\\Users\\win', HOME: '/home/unix' };
  assert.equal(resolveUserHome('win32', env), 'C:\\Users\\win');
  assert.equal(resolveUserHome('linux', env), '/home/unix');
  assert.equal(resolveUserHome('darwin', env), '/home/unix');
});

test('macOS Application Support legacy roots migrate into canonical home', () => {
  const home = tempDir();
  const legacy = path.join(home, 'Library', 'Application Support', 'Gourd AI');
  put(legacy, '.gwork/usage/usage.json', 'old-usage');
  put(legacy, '.gourdai/usage-submission/device-key', 'old-device');
  put(legacy, '.gwork/outbox/item.json', 'old-outbox');
  migrateGlobalData({ homeDir: home, legacyRoots: [path.join(legacy, '.gwork'), path.join(legacy, '.gourdai')] });
  assert.equal(read(path.join(home, '.gwork'), 'usage/usage.json'), 'old-usage');
  assert.equal(read(path.join(home, '.gwork'), 'usage-submission/device-key'), 'old-device');
  assert.equal(read(path.join(home, '.gwork'), 'outbox/item.json'), 'old-outbox');
});

test('only the ROOT bin is skipped; nested bin payloads survive', () => {
  const home = tempDir();
  const staging = path.join(home, '.gwork-desktop-migration', 'install-gwork');
  put(staging, 'bin/gwork.bat', 'stale-launcher');
  put(staging, 'skills/my-skill/bin/run.sh', 'skill-script');
  put(staging, 'extensions/ext-a/bin/tool', 'ext-tool');
  put(staging, 'agents/team/bin/nested/deep.sh', 'deep-script');
  migrateGlobalData({ homeDir: home });
  const target = path.join(home, '.gwork');
  assert.equal(has(target, 'bin'), false, 'root bin must not be imported');
  assert.equal(read(target, 'skills/my-skill/bin/run.sh'), 'skill-script');
  assert.equal(read(target, 'extensions/ext-a/bin/tool'), 'ext-tool');
  assert.equal(read(target, 'agents/team/bin/nested/deep.sh'), 'deep-script');
});

test('nested legacy .gourdai is folded into the root, not copied as a subdirectory', () => {
  const home = tempDir();
  put(path.join(home, '.gourdai'), 'settings.json', 'outer');
  put(path.join(home, '.gourdai'), '.gourdai/memory/notes.md', 'nested');
  migrateGlobalData({ homeDir: home });
  const target = path.join(home, '.gwork');
  assert.equal(read(target, 'settings.json'), 'outer');
  assert.equal(read(target, 'memory/notes.md'), 'nested');
  assert.equal(has(target, '.gourdai'), false, 'no junk .gourdai inside the canonical home');
});

test('migration merges sources, preserves target priority, and is idempotent', () => {
  const home = tempDir();
  const resources = path.join(home, 'resources', 'extraResources');
  const staging = path.join(home, '.gwork-desktop-migration');
  fs.mkdirSync(resources, { recursive: true });
  put(path.join(resources, '.gwork'), 'usage/usage.json', 'resource-canonical');
  put(path.join(resources, '.gwork'), 'bin/old-launcher', 'must-not-copy');
  put(path.join(resources, '.gourdai'), 'settings.json', 'outer-resource');
  put(path.join(resources, '.gourdai'), '.gourdai/usage-submission/device-key', 'nested-resource');
  put(path.join(home, '.gourdai'), 'settings.json', 'outer-home');
  put(path.join(home, '.gourdai'), '.gourdai/session-roots/root.json', 'nested-home');
  put(path.join(staging, 'install-gwork'), 'usage/usage.json', 'staged-canonical');
  put(path.join(staging, 'install-gwork'), 'outbox/item.json', 'outbox');
  put(path.join(staging, 'install-gourdai'), 'settings.json', 'staged-legacy');
  put(path.join(staging, 'install-gourdai'), '.gourdai/usage-submission/device-key', 'staged-nested');
  put(path.join(home, '.gwork'), 'usage/usage.json', 'existing-target');
  put(path.join(home, '.gwork'), 'settings.json', 'canonical-settings');
  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  const target = path.join(home, '.gwork');
  assert.equal(read(target, 'usage/usage.json'), 'existing-target');
  assert.equal(read(target, 'settings.json'), 'canonical-settings');
  assert.equal(read(target, 'usage-submission/device-key'), 'nested-resource');
  assert.equal(read(target, 'session-roots/root.json'), 'nested-home');
  assert.equal(read(target, 'outbox/item.json'), 'outbox');
  assert.equal(has(target, 'bin'), false);
  assert.equal(fs.existsSync(path.join(staging, 'install-gwork')), false);
  assert.equal(fs.existsSync(path.join(staging, 'install-gourdai')), false);
  const snap = () => fs.readdirSync(target, { recursive: true }).sort()
    .map((n) => [n, fs.statSync(path.join(target, n)).isFile() ? read(target, n) : 'dir']);
  const snapshot = snap();
  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  assert.deepEqual(snap(), snapshot);
});

test('a consumed install-directory source is not re-merged, so deleted files stay deleted', () => {
  const home = tempDir();
  const resources = path.join(home, 'resources', 'extraResources');
  put(path.join(resources, '.gwork'), 'settings.json', 'from-install-dir');
  put(path.join(resources, '.gwork'), 'skills/demo.md', 'skill');

  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  const target = path.join(home, '.gwork');
  assert.equal(read(target, 'settings.json'), 'from-install-dir');
  assert.ok(has(target, STATE_FILE), 'state file records the consumed source');

  // The install directory is read-only in production, so the source survives.
  // A second launch must NOT resurrect what the user deliberately removed.
  fs.rmSync(path.join(target, 'skills'), { recursive: true, force: true });
  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  assert.equal(has(target, 'skills'), false, 'deleted user data must not come back');

  // A reinstall rewrites the source directory (mtime bump) and must migrate again.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(resources, '.gwork'), future, future);
  migrateGlobalData({ homeDir: home, resourcesDir: resources });
  assert.equal(read(target, 'skills/demo.md'), 'skill', 'a fresh install payload is migrated again');
});

test('migration failures preserve staging for the next attempt', () => {
  const home = tempDir();
  const staging = path.join(home, '.gwork-desktop-migration', 'install-gwork');
  put(staging, 'settings.json', 'data');

  const realCopyFile = fs.copyFileSync;
  fs.copyFileSync = () => { const e = new Error('injected copy failure'); e.code = 'EIO'; throw e; };
  try {
    assert.throws(() => migrateGlobalData({ homeDir: home }), /injected copy failure/);
  } finally {
    fs.copyFileSync = realCopyFile;
  }
  assert.equal(fs.existsSync(staging), true, 'staging must survive a failed merge');

  // Retry after the transient failure clears.
  migrateGlobalData({ homeDir: home });
  assert.equal(read(path.join(home, '.gwork'), 'settings.json'), 'data');
  assert.equal(fs.existsSync(staging), false);
});
