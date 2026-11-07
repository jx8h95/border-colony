// test/llm.mjs — 大模型接入层单测（全程 mock，不需要真实 API Key / 网络）
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROVIDERS, resolveConfig, maskKey, askLLM, testLLM, extractJSON, assertSafeBaseURL,
} from '../server/llm.js';
import {
  normalizeProfile, publicProfile, profileConfig, ProfileVault, displayName,
} from '../server/profiles.js';
import { normalizeControllers, strategyForAI } from '../server/controllers.js';
import { LLM_STYLE, styleFor, buildPrompt, sanitizeActions } from '../server/gameLoop.js';
import { STRATEGIES } from '../server/bots.js';
import { createGame, getViewFor, AI_IDS } from '../server/engine.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

/* 固定环境，避免机器上真有 Key 影响断言 */
const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
};
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
process.env.OPENAI_MODEL = 'gpt-4o-mini';

const originalFetch = globalThis.fetch;
let captured = null;
let reply = { status: 200, body: {}, text: null };
function mockFetch() {
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    if (reply.rawFetch) return reply.rawFetch(url, init);
    const payload = reply.text !== null ? reply.text : JSON.stringify(reply.body);
    return new Response(payload, { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
}
function reset() { captured = null; reply = { status: 200, body: {}, text: null }; }

console.log('\n配置解析 / 服务商预设');

test('默认配置：无需任何填写就有端点与模型，无 Key 时 hasKey=false', () => {
  const c = resolveConfig({});
  assert.equal(c.provider, 'openai');
  assert.equal(c.baseURL, 'https://api.openai.com/v1');
  assert.equal(c.model, 'gpt-4o-mini');
  assert.equal(c.hasKey, false);
  assert.equal(c.source, 'none');
});

test('7 个服务商预设都带齐端点与模型', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, key);
    if (key !== 'custom') { assert.ok(p.baseURL, key); assert.ok(p.model, key); }
    const c = resolveConfig({ provider: key, apiKey: 'sk-abcdefgh1234' });
    if (key !== 'custom') { assert.equal(c.baseURL, p.baseURL); assert.equal(c.model, p.model); }
  }
});

test('自定义端点不填就保持为空，不会偷偷连到 OpenAI 官方', () => {
  const c = resolveConfig({ provider: 'custom', apiKey: 'sk-abcdefgh1234' });
  assert.equal(c.baseURL, '');
  assert.equal(c.model, '');
});

test('运行时 Key 优先于环境变量，来源标记正确', () => {
  process.env.OPENAI_API_KEY = 'sk-from-env-123456';
  const a = resolveConfig({});
  assert.equal(a.source, 'env');
  const b = resolveConfig({ apiKey: 'sk-from-panel-123456' });
  assert.equal(b.source, 'runtime');
  assert.equal(b.apiKey, 'sk-from-panel-123456');
  delete process.env.OPENAI_API_KEY;
});

test('脱敏只留前 3 后 4，且接口配置对象不含明文', () => {
  const k = 'sk-test-1234567890';
  assert.equal(maskKey(k), 'sk-••••7890');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('sk-...'), '');
  const pub = { ...resolveConfig({ apiKey: k }) };
  delete pub.apiKey;
  assert.ok(!JSON.stringify(pub).includes(k));
});

console.log('\n请求协议');

await atest('OpenAI 兼容：Bearer 鉴权 + /chat/completions + 解析 content', async () => {
  reset(); mockFetch();
  reply.body = { choices: [{ message: { content: '{"actions":[]}' } }] };
  const out = await askLLM('hello', { apiKey: 'sk-unit-123456789', provider: 'deepseek' });
  assert.equal(out, '{"actions":[]}');
  assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(captured.init.headers.authorization, 'Bearer sk-unit-123456789');
  assert.equal(captured.body.model, 'deepseek-chat');
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hello' }]);
});

await atest('Anthropic 原生：x-api-key + /messages + 拼接 content 块', async () => {
  reset(); mockFetch();
  reply.body = { content: [{ type: 'text', text: '{"actions":' }, { type: 'text', text: '[]}' }] };
  const out = await askLLM('hello', { apiKey: 'sk-ant-unit-123456', provider: 'anthropic' });
  assert.equal(out, '{"actions":[]}');
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.init.headers['x-api-key'], 'sk-ant-unit-123456');
  assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.body.max_tokens > 0, true);
});

await atest('自定义端点：Base URL / 模型都按填写值走', async () => {
  reset(); mockFetch();
  reply.body = { choices: [{ message: { content: 'ok' } }] };
  await askLLM('x', {
    provider: 'custom', apiKey: 'sk-local-123456',
    baseURL: 'http://127.0.0.1:9999/v1/', model: 'my-model',
  });
  assert.equal(captured.url, 'http://127.0.0.1:9999/v1/chat/completions');
  assert.equal(captured.body.model, 'my-model');
});

await atest('HTTP 401 给出 Key 无效提示', async () => {
  reset(); mockFetch();
  reply.status = 401;
  reply.text = JSON.stringify({ error: { message: 'invalid api key' } });
  await assert.rejects(
    () => askLLM('x', { apiKey: 'sk-bad-123456789' }),
    /HTTP 401.*API Key 无效.*invalid api key/
  );
});

await atest('超时被转换为可读错误', async () => {
  reset(); mockFetch();
  reply.rawFetch = (url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  await assert.rejects(
    () => askLLM('x', { apiKey: 'sk-slow-123456789', timeoutMs: 5000 }),
    /请求超时（5000ms）/
  );
});

await atest('testLLM 返回耗时与模型回复预览', async () => {
  reset(); mockFetch();
  reply.body = { choices: [{ message: { content: '正常' } }] };
  const r = await testLLM({ apiKey: 'sk-ok-123456789' });
  assert.equal(r.ok, true);
  assert.equal(r.preview, '正常');
  assert.ok(r.ms >= 0);
  assert.equal(captured.body.max_tokens <= 32, true);
});

console.log('\n输出清洗 / 提示词');

test('extractJSON 处理代码块、前后解释文字；坏输出返回 null', () => {
  assert.deepEqual(extractJSON('说明：\n```json\n{"actions":[1]}\n```\n结束'), { actions: [1] });
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.equal(extractJSON('没有 JSON'), null);
  assert.equal(extractJSON('{bad json}'), null);
});

test('styleFor：auto=自主决策，其余映射到脚本人格', () => {
  assert.equal(styleFor('auto').name, '自主决策');
  assert.equal(styleFor('economist'), STRATEGIES.economist);
  assert.equal(styleFor('不存在的策略'), LLM_STYLE);
});

test('buildPrompt 含当前势力、规则要点与动作格式', () => {
  const g = createGame(7, { cfg: {} });
  const v = getViewFor(g, 'A');
  const p = buildPrompt(v, styleFor('auto'));
  assert.ok(p.includes('AI 玩家 A'));
  assert.ok(p.includes('走过'));
  assert.ok(p.includes('"produce"'));
  assert.ok(p.includes('包围'));
});

test('buildPrompt 含逐格地图、上回合被拒数与严格 path 规则', () => {
  const g = createGame(7, { cfg: {} });
  const p = buildPrompt(getViewFor(g, 'A'), styleFor('auto'));
  assert.ok(p.includes('"territoryMap"'), '应下发与脚本等价的逐格地图');
  assert.ok(p.includes('"lastRejected"'), '应回灌四家对称的被拒统计');
  assert.ok(p.includes('信息对称'), '应明确说明没有任何一方开图');
  assert.ok(p.includes('首格必须与士兵当前坐标相邻'));
  assert.ok(p.includes('不会替你截断或纠偏'), '裁判不得替模型修正动作');
  assert.equal((p.match(/^    "[.ABCD#?]{50}",?$/gm) || []).length, 50, '地图应为 50 行 × 50 字符（含 # 障碍）');
});

test('提示词说明深灰障碍与中央黄金矿', () => {
  const g = createGame(7, { cfg: {} });
  const p = buildPrompt(getViewFor(g, 'A'), styleFor('auto'));
  assert.ok(p.includes('"goldMine"'), '应下发黄金矿归属与产出');
  assert.ok(p.includes('"wallCount"'), '应下发障碍格数');
  assert.ok(p.includes('#=障碍'), '地图图例要说明 # 是什么');
  assert.ok(p.includes('中央黄金矿'), '要写清黄金矿规则');
  assert.ok(p.includes('每回合自动 +2 资源'), '要写清默认产出');
  assert.ok(p.includes('不能走上去、不能被占领'), '要写清障碍不可通行/不可占领');
});

test('脚本风格文案不带作废的距离衰减规则', () => {
  const all = Object.values(STRATEGIES).map(s => s.style).join('\n');
  assert.ok(!all.includes('近基地血量上限高'));
  assert.ok(!all.includes('距离掉血'));
});

test('sanitizeActions 丢弃越权单位、限制 produce 次数、补齐未下令士兵', () => {
  const g = createGame(7, { cfg: {} });
  const v = getViewFor(g, 'A');
  const mine = v.units[0].id;
  const out = sanitizeActions([
    { unit: mine, type: 'move', path: [[v.units[0].x + 1, v.units[0].y]] },
    { unit: 'B01', type: 'attack', target: mine },
    { type: 'produce' }, { type: 'produce' },
  ], v, 'A');
  assert.equal(out.filter(a => a.type === 'produce').length, 1);
  assert.ok(!out.some(a => a.unit === 'B01'));
  assert.equal(out.filter(a => a.unit).length, v.units.length);
});

console.log('\n势力操控归一化');

test('默认四家都是脚本，打法按位置分配', () => {
  const c = normalizeControllers(null, ['aggressive', 'economist', 'fortress', 'turtle']);
  assert.deepEqual(AI_IDS.map(a => c[a].mode), ['bot', 'bot', 'bot', 'bot']);
  assert.deepEqual(AI_IDS.map(a => c[a].strategy), ['aggressive', 'economist', 'fortress', 'turtle']);
});

test('简写 / 完整对象 / 旧版策略数组都兼容', () => {
  const valid = ['aggressive', 'economist', 'fortress', 'turtle'];
  const a = normalizeControllers({ A: 'llm', B: { mode: 'bot', strategy: 'turtle' } }, valid);
  assert.deepEqual(a.A, { mode: 'llm', strategy: 'auto' });
  assert.deepEqual(a.B, { mode: 'bot', strategy: 'turtle' });
  const b = normalizeControllers(['turtle', 'fortress', 'economist', 'aggressive'], valid);
  assert.equal(b.A.strategy, 'turtle');
  assert.equal(b.D.strategy, 'aggressive');
});

test('非法值不会污染配置；脚本模式下的 auto 落到默认打法', () => {
  const c = normalizeControllers({ A: { mode: 'llm', strategy: 'auto' }, B: { mode: 'bot', strategy: 'auto' } }, ['aggressive']);
  assert.equal(c.A.strategy, 'auto');
  assert.equal(c.B.strategy, 'economist');
  assert.equal(strategyForAI(c, 'B', 1), 'economist');
});

console.log('\n多模型配置（v6.3）');

test('strictKey：多模型配置不回落 .env，避免 A 家 Key 串到 B 家', () => {
  process.env.OPENAI_API_KEY = 'sk-env-should-not-leak';
  process.env.OPENAI_BASE_URL = 'https://evil.example/v1';
  process.env.OPENAI_MODEL = 'env-model';
  const strict = resolveConfig({ provider: 'deepseek', apiKey: '', strictKey: true });
  assert.equal(strict.hasKey, false);
  assert.equal(strict.baseURL, PROVIDERS.deepseek.baseURL);
  assert.equal(strict.model, PROVIDERS.deepseek.model);
  const withKey = resolveConfig({ provider: 'deepseek', apiKey: 'sk-own-123456', strictKey: true });
  assert.equal(withKey.apiKey, 'sk-own-123456');
  // 不带 strictKey 时仍保持旧的 env 兜底行为
  assert.equal(resolveConfig({ provider: 'openai' }).source, 'env');
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
});

test('normalizeProfile：自动命名、更新保留 Key、换服务商落回新预设', () => {
  const a = normalizeProfile({ provider: 'deepseek', apiKey: 'sk-a-123456' });
  assert.equal(a.provider, 'deepseek');
  assert.equal(a.model, 'deepseek-chat');
  assert.ok(a.name.includes('DeepSeek'));
  const b = normalizeProfile({ name: '我的 GPT' }, a);
  assert.equal(b.apiKey, 'sk-a-123456', '没传 Key 应沿用旧 Key');
  assert.equal(b.name, '我的 GPT');
  assert.equal(b.id, a.id);
  const c = normalizeProfile({ provider: 'openai', name: '换家' }, a);
  assert.equal(c.baseURL, PROVIDERS.openai.baseURL, '换服务商且未指定端点应落回新预设');
  assert.equal(c.model, PROVIDERS.openai.model);
});

test('publicProfile 只给脱敏信息，profileConfig 才带明文与 strictKey', () => {
  const p = normalizeProfile({ name: '主力', provider: 'qwen', apiKey: 'sk-secret-998877' });
  const pub = publicProfile(p, null);
  assert.equal('apiKey' in pub, false);
  assert.ok(!JSON.stringify(pub).includes('sk-secret-998877'));
  assert.equal(pub.keyMask, maskKey('sk-secret-998877'));
  assert.equal(pub.name, '主力');
  assert.equal(publicProfile(p, p.id).isDefault, true);
  const cfg = profileConfig(p);
  assert.equal(cfg.apiKey, 'sk-secret-998877');
  assert.equal(cfg.strictKey, true);
  assert.equal(displayName({ ...p, name: '' }), p.model);
});

test('ProfileVault：多份 Key 增删 / 同名去重 / 默认模型 / 落盘恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-profiles-'));
  const file = path.join(dir, 'profiles.json');
  try {
    const v = new ProfileVault(file);
    assert.deepEqual(v.list(), []);
    const a = v.upsert({ name: 'DeepSeek 主力', provider: 'deepseek', apiKey: 'sk-aaa-123456' });
    const b = v.upsert({ name: 'GPT 备用', provider: 'openai', apiKey: 'sk-bbb-123456' });
    assert.equal(v.items.length, 2);
    assert.equal(v.getDefault().id, a.id, '第一份自动成为默认');
    assert.equal(a.apiKey, 'sk-aaa-123456');
    assert.equal(b.apiKey, 'sk-bbb-123456');
    const list = v.list();
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes('sk-aaa-123456'));
    assert.ok(!JSON.stringify(list).includes('sk-bbb-123456'));
    assert.equal(list[0].isDefault, true);

    const dup = v.upsert({ name: 'DeepSeek 主力', provider: 'zhipu', apiKey: 'sk-ccc-123456' });
    assert.equal(dup.name, 'DeepSeek 主力 #2');
    const edited = v.upsert({ id: b.id, name: 'GPT 备用', model: 'gpt-4o' });
    assert.equal(edited.apiKey, 'sk-bbb-123456');
    assert.equal(edited.model, 'gpt-4o');

    v.setDefault(b.id);
    assert.equal(v.getDefault().id, b.id);
    const v2 = new ProfileVault(file);
    assert.equal(v2.items.length, 3);
    assert.equal(v2.getDefault().id, b.id, '重启后默认模型与 Key 应恢复');
    assert.equal(v2.get(b.id).apiKey, 'sk-bbb-123456');
    v2.markTested(b.id);
    assert.ok(new ProfileVault(file).get(b.id).testedAt);

    v2.remove(b.id);
    assert.equal(v2.items.length, 2);
    assert.ok(v2.getDefault(), '删掉默认后自动挑剩下的第一份');
    assert.equal(v2.get(b.id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeControllers：profileId 只在大模型模式下透传，且可过滤失效 id', () => {
  const valid = ['aggressive', 'economist', 'fortress', 'turtle'];
  const c = normalizeControllers({
    A: { mode: 'llm', strategy: 'auto', profileId: 'm_aaa' },
    B: { mode: 'bot', strategy: 'turtle', profileId: 'm_bbb' },
    C: 'llm',
  }, valid);
  assert.deepEqual(c.A, { mode: 'llm', strategy: 'auto', profileId: 'm_aaa' });
  assert.deepEqual(c.B, { mode: 'bot', strategy: 'turtle' }, '脚本模式不该带模型 id');
  assert.deepEqual(c.C, { mode: 'llm', strategy: 'auto' });
  const filtered = normalizeControllers({ A: { mode: 'llm', profileId: 'm_gone' } }, valid, new Set(['m_aaa']));
  assert.equal(filtered.A.profileId, undefined, '已删除的模型引用应被清掉');
});

console.log('\n端点安全校验（防 Key 外带）');

test('允许官方 https / 本机 http / 空值，拒绝内网与元数据地址', () => {
  for (const u of [
    '', PROVIDERS.openai.baseURL, PROVIDERS.deepseek.baseURL,
    'http://127.0.0.1:11434/v1', 'http://localhost:9999/v1/', 'https://my-proxy.example/v1',
  ]) assert.doesNotThrow(() => assertSafeBaseURL(u), u);

  for (const u of [
    'https://169.254.169.254/latest/meta-data', 'https://192.168.1.10/v1',
    'https://10.0.0.5/v1', 'https://172.16.3.4/v1',
    'http://api.example.com/v1', 'https://user:pass@api.example.com/v1',
    'file:///etc/passwd', 'not-a-url',
  ]) assert.throws(() => assertSafeBaseURL(u), undefined, u);
});

test('LLM_ALLOW_PRIVATE_ENDPOINTS=1 才放行局域网自建端点', () => {
  assert.throws(() => assertSafeBaseURL('http://192.168.1.10:11434/v1'));
  process.env.LLM_ALLOW_PRIVATE_ENDPOINTS = '1';
  assert.doesNotThrow(() => assertSafeBaseURL('http://192.168.1.10:11434/v1'));
  delete process.env.LLM_ALLOW_PRIVATE_ENDPOINTS;
});

/* 还原环境 */
globalThis.fetch = originalFetch;
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
