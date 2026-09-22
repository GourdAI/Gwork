const fs = require('fs');

const target = 'gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebGate.java';
const insertFile = '.gwork-review-insert.tmp';

const raw = fs.readFileSync(target, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r\n|\n/);

const insertRaw = fs.readFileSync(insertFile, 'utf8');
if (insertRaw.includes('\uFFFD')) {
    throw new Error('insert file contains replacement char U+FFFD');
}
const insertLines = insertRaw.split(/\r\n|\n/);
while (insertLines.length && insertLines[insertLines.length - 1] === '') {
    insertLines.pop();
}
insertLines.push('');

// ---- step 1: locate & remove the old stale-cleanup block ----
const startIdx = lines.findIndex(l => l.includes('【僵尸挂起任务清理】'));
if (startIdx < 0) {
    throw new Error('old block start anchor not found');
}
// block = comment lines + if(...){...} ; find closing brace at same indent (12 spaces)
let endIdx = -1;
for (let i = startIdx; i < startIdx + 40 && i < lines.length; i++) {
    if (lines[i] === '            }') {
        endIdx = i;
        break;
    }
}
if (endIdx < 0) {
    throw new Error('old block end anchor not found');
}
// also swallow the single blank line right after
let removeEnd = endIdx;
if (lines[endIdx + 1] === '') {
    removeEnd = endIdx + 1;
}
const removed = lines.slice(startIdx, removeEnd + 1);
if (!removed.some(l => l.includes('AskUser.discardPending'))) {
    throw new Error('removal range does not contain discardPending, aborting');
}
if (removed.filter(l => l.includes('ofQuestionAnswered')).length !== 1) {
    throw new Error('removal range unexpected ofQuestionAnswered count');
}
lines.splice(startIdx, removeEnd - startIdx + 1);

// ---- step 2: insert new block right before the resume-continuation comment ----
const anchorIdx = lines.findIndex(l => l.includes('// 中断续跑：上次任务异常中断'));
if (anchorIdx < 0) {
    throw new Error('insert anchor not found');
}
// sanity: anchor must be inside the "has input" branch (indent 16)
if (!/^ {16}\/\//.test(lines[anchorIdx])) {
    throw new Error('insert anchor indent unexpected: ' + JSON.stringify(lines[anchorIdx].slice(0, 30)));
}
lines.splice(anchorIdx, 0, ...insertLines);

const out = lines.join(eol);
if (out.includes('\uFFFD')) {
    throw new Error('result contains replacement char U+FFFD');
}
fs.writeFileSync(target, out, 'utf8');
console.log('OK eol=' + JSON.stringify(eol) + ' removedLines=' + removed.length + ' insertedLines=' + insertLines.length);
console.log('removed block head: ' + removed[0].trim().slice(0, 40));
console.log('insert anchor was line ' + (anchorIdx + 1));
