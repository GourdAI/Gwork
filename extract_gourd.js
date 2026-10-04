const fs = require('fs');
const raw = fs.readFileSync(process.env.USERPROFILE + '\\.gwork\\settings.json', 'utf8');
// 找到 GourdWork 渠道配置
const gourdIdx = raw.indexOf('"GourdWork"');
if (gourdIdx === -1) {
    console.log('GourdWork channel not found');
} else {
    const chunk = raw.substring(gourdIdx, gourdIdx + 4000);
    console.log(chunk);
}
// 也找 defaultModel
const dmIdx = raw.indexOf('"defaultModel"');
if (dmIdx !== -1) {
    console.log('\n=== defaultModel ===');
    console.log(raw.substring(dmIdx, dmIdx + 200));
}
