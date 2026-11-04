/**
 * WebSocket 僵尸连接检测 —— 源码存在性契约测试。
 *
 * 根因：长时间闲置/系统休眠/网络切换后，浏览器侧 WS 可能进入「半开」状态
 * （readyState 恒为 OPEN、onclose/onerror 永不触发），后端所有流式帧静默丢失。
 * 前端心跳旧实现只发 ping 从不校验 pong，导致僵尸连接永远检测不到、永不重连。
 * 修复：连续 3 个心跳周期（15s×3=45s）未收到 pong 即强制 close 并走重连恢复。
 *
 * 验证方式：读取 app-streaming.js 源码，断言关键代码形态存在。
 * 注：所有断言用 indexOf（字符串包含）而非正则——避免正则本身成为脆弱断言。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../main/resources/static/js/app-streaming.js');
const src = fs.readFileSync(SRC, 'utf8');

function has(text) { return src.includes(text); }

describe('僵尸连接检测源码存在性', () => {
  it('声明了 webGatePongMisses 计数变量', () => {
    assert(has('var webGatePongMisses = 0'), '缺少 webGatePongMisses 变量声明');
  });

  it('心跳回调里递增计数（连续未收到 pong 的检测）', () => {
    assert(has('webGatePongMisses = (webGatePongMisses || 0) + 1'), '缺少计数递增逻辑');
  });

  it('阈值 >= 3 触发强制 close + 重连调度', () => {
    assert(has('if (webGatePongMisses >= 3)'), '缺少阈值判定（>=3）');
    assert(has('dead.close()'), '缺少 close() 强制拆除僵尸连接');
    assert(has('scheduleWebGateReconnect()'), '缺少重连调度兜底');
  });

  it('onmessage pong 帧清零计数（在 return 之前）', () => {
    assert(has("raw === 'pong'"), '缺少 pong 帧识别');
    const idx = src.indexOf("raw === 'pong'");
    assert(idx > 0, 'pong 分支未找到');
    const block = src.slice(idx, idx + 300);
    assert(block.includes('webGatePongMisses = 0'), 'pong 帧未清零计数');
  });

  it('onmessage 业务帧也清零计数（防止高频帧期 pong 交错误判）', () => {
    const idx = src.indexOf('var chunk = JSON.parse(raw);');
    assert(idx > 0, 'JSON.parse 行未找到');
    const block = src.slice(idx, idx + 200);
    assert(block.includes('webGatePongMisses = 0'), '业务帧未清零计数');
  });

  it('stopWebGateHeartbeat 重置计数（重连后归零）', () => {
    const idx = src.indexOf('function stopWebGateHeartbeat');
    assert(idx > 0, 'stopWebGateHeartbeat 未找到');
    const block = src.slice(idx, idx + 300);
    assert(block.includes('webGateHeartbeatTimer = null'), 'timer 未清空');
    assert(block.includes('webGatePongMisses = 0'), 'stop 时未重置计数');
  });
});
