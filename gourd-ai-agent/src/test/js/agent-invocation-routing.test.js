const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/js/app-message.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' source not found');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name + ' closing brace not found');
}

const resolveAgentState = Function(extractFunction('resolveAgentState') + '; return resolveAgentState;')();

test('invocationId routes identical parallel agents independently', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const sess = {
    agentCards: { 'inv-a': {}, 'inv-b': {} },
    agentStates: { 'inv-a': a, 'inv-b': b }
  };
  assert.equal(resolveAgentState(sess, { agentName: 'explore', agentDesc: 'same', invocationId: 'inv-a' }), a);
  assert.equal(resolveAgentState(sess, { agentName: 'explore', agentDesc: 'same', invocationId: 'inv-b' }), b);
});

test('legacy frames without invocationId fall back to name:description', () => {
  const legacy = { id: 'legacy' };
  const sess = {
    agentCards: { 'explore:same': {} },
    agentStates: { 'explore:same': legacy }
  };
  assert.equal(resolveAgentState(sess, { agentName: 'explore', agentDesc: 'same' }), legacy);
});
