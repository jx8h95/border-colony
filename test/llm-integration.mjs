// test/llm-integration.mjs — 端到端：本地 mock 一个 OpenAI 兼容端点，验证「只填 Key 就能跑」
// 不需要真实 API Key、不访问外网、不改动 .env。会临时在 3398/3399 起两个服务。
import http from 'http';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAME_PORT = 3399;
const MOCK_PORT = 3398;
const BASE = `http://127.0.0.1:${GAME_PORT}`;
const KEY = 'sk-mock-1234567890';
const KEY_A = 'sk-mock-aaaa-1234567890';
const KEY_B = 'sk-mock-bbbb-1234567890';
const ENV_PATH = path.join(ROOT, '.env');
// .env 被 .gitignore 忽略，干净检出 / CI 里根本不存在，不能在这里硬崩
const readEnv = () => fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : null;
const envBefore = readEnv();
// 多模型配置写到临时目录，测试之间互不污染，也不碰本机真实保存的 Key
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-itest-profiles-'));
let profileA = '', profileB = '';

const requests = [];
let mockStatus = 200;
let mockContent = '```json\n{"actions":[{"type":"produce"}]}\n```';

const mock = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => { buf += c; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(buf || '{}') });
    res.writeHead(mockStatus, { 'content-type': 'application/json' });
    res.end(mockStatus === 200
      ? JSON.stringify({ choices: [{ message: { content: mockContent } }] })
      : JSON.stringify({ error: { message: 'mock failure' } }));
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body = {}) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const get = p => fetch(BASE + p).then(r => r.json());

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 未起 */ }
    await sleep(100);
  }
  throw new Error('游戏服务未能在 6 秒内启动');
}

let child = null;
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

try {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(GAME_PORT),
      LLM_PROFILES_FILE: path.join(tmpDir, 'profiles.json'),
      LLM_MEMORY_FILE: path.join(tmpDir, 'memory.json'),
      // 本机 .env 里可能真有 Key；测试环境显式置空，dotenv 不会覆盖已有变量
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  child.stderr.on('data', c => { serverErr += c.toString(); });
  await waitReady();

  console.log('\n端到端：mock 大模型 + 混合操控');

  await test('初始配置不要求 Key，且响应不含 apiKey 字段', async () => {
    const c = await get('/api/llm/config');
    assert.equal(c.ok, true);
    assert.equal(c.hasKey, false);
    assert.equal('apiKey' in c, false);
    assert.ok(c.presets.length >= 6);
  });

  await test('只提交 apiKey + 自定义端点即可保存，Key 被脱敏', async () => {
    const r = await post('/api/llm/config', {
      provider: 'custom', apiKey: KEY,
      baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model',
      persist: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.hasKey, true);
    assert.equal(r.model, 'mock-model');
    assert.equal(r.keyMask, 'sk-••••7890');
    assert.equal('apiKey' in r, false);
  });

  await test('测试连接：mock 收到 Bearer Key、端点与模型正确，且自动收下密钥', async () => {
    const r = await post('/api/llm/test', { persist: false });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.autoSaved, false); // Key 已在上一步保存
    const q = requests[0];
    assert.equal(q.url, '/v1/chat/completions');
    assert.equal(q.headers.authorization, `Bearer ${KEY}`);
    assert.equal(q.body.model, 'mock-model');
  });

  await test('改到别的自定义端点且未给 Key：不继承已存 Key，一个请求都不发出', async () => {
    const n = requests.length;
    const r = await post('/api/llm/test', { baseURL: 'https://key-exfil.example/v1', model: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /API Key/);
    assert.equal(requests.length, n, '带不走 Key，也不该向外发请求');
    const c = await get('/api/llm/config');
    assert.equal(c.hasKey, true, '已保存配置不该被探测请求破坏');
    assert.equal(c.model, 'mock-model');
  });

  await test('换成 A 由大模型操控：assignment / leaderboard 同步标记', async () => {
    await post('/api/controllers', {
      controllers: {
        A: { mode: 'llm', strategy: 'auto' },
        B: { mode: 'bot', strategy: 'economist' },
        C: { mode: 'bot', strategy: 'fortress' },
        D: { mode: 'bot', strategy: 'turtle' },
      },
    });
    await post('/api/new', { seed: 2026, cfg: { turns: 8 } });
    const g = (await get('/api/state')).game;
    assert.equal(g.assignment.A, 'llm');
    assert.equal(g.leaderboard.find(x => x.ai === 'A').mode, 'llm');
    assert.equal(g.leaderboard.length, 4);
    assert.ok(g.records.A);
  });

  await test('单步：大模型动作生效（A 全军 wait 原地不动），状态标记 ok', async () => {
    const before = (await get('/api/state')).game;
    const posBefore = Object.fromEntries(before.units.filter(u => u.owner === 'A').map(u => [u.id, [u.x, u.y]]));
    const n = requests.length;
    const r = await post('/api/step');
    assert.equal(r.ok, true);
    const g = r.game;
    assert.equal(g.turn, 1);
    assert.ok(requests.length > n, '本回合应该真的调用了模型');
    assert.equal(g.llm.perAI.A.state, 'ok');
    assert.ok(g.llm.perAI.A.ms >= 0);
    const posAfter = Object.fromEntries(g.units.filter(u => u.owner === 'A').map(u => [u.id, [u.x, u.y]]));
    for (const [id, p] of Object.entries(posBefore)) {
      if (posAfter[id]) assert.deepEqual(posAfter[id], p, `${id} 不该移动（模型下令 wait）`);
    }
    assert.ok(!JSON.stringify(g).includes(KEY), '快照里不能出现明文 Key');
  });

  await test('模型报错时自动降级为脚本，回合照常推进', async () => {
    mockStatus = 500;
    const r = await post('/api/step');
    mockStatus = 200;
    const g = r.game;
    assert.equal(g.turn, 2);
    assert.equal(g.llm.perAI.A.state, 'error');
    assert.ok(/HTTP 500/.test(g.llm.perAI.A.error));
    assert.ok(g.territoryCount.A > 0, '降级后脚本仍应开垦领土');
  });

  await test('输出非法 JSON 时标记 parse 并降级，不中断对局', async () => {
    mockContent = '我觉得这回合应该稳住，不输出 JSON';
    const r = await post('/api/step');
    mockContent = '```json\n{"actions":[{"type":"produce"}]}\n```';
    assert.equal(r.game.turn, 3);
    assert.equal(r.game.llm.perAI.A.state, 'parse');
  });

  await test('保存两份不同的 Key：都脱敏，势力下拉拿到 2 个可选项', async () => {
    const a = await post('/api/llm/profiles', {
      name: '模型甲', provider: 'custom', apiKey: KEY_A,
      baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'model-a',
      makeDefault: true, persist: false,
    });
    assert.equal(a.ok, true, a.error);
    assert.equal(a.madeDefault, true);
    profileA = a.profile.id;
    const b = await post('/api/llm/profiles', {
      name: '模型乙', provider: 'custom', apiKey: KEY_B,
      baseURL: `http://127.0.0.1:${MOCK_PORT}/v2`, model: 'model-b',
      makeDefault: false, persist: false,
    });
    assert.equal(b.ok, true, b.error);
    assert.equal(b.madeDefault, false);
    profileB = b.profile.id;
    assert.notEqual(profileA, profileB);
    assert.equal(b.profiles.length, 2);
    assert.ok(!JSON.stringify(a).includes(KEY_A), '响应不能有明文 Key 甲');
    assert.ok(!JSON.stringify(b).includes(KEY_B), '响应不能有明文 Key 乙');
    const c = await get('/api/llm/config');
    assert.equal(c.profiles.length, 2);
    assert.equal(c.defaultProfileId, profileA);
    assert.equal(c.profiles[0].keyMask, 'sk-••••7890');
  });

  await test('A 选模型甲、B 选模型乙：同一回合各自带自己的 Key 与端点', async () => {
    await post('/api/controllers', {
      controllers: {
        A: { mode: 'llm', strategy: 'auto', profileId: profileA },
        B: { mode: 'llm', strategy: 'auto', profileId: profileB },
        C: { mode: 'bot', strategy: 'fortress' },
        D: { mode: 'bot', strategy: 'turtle' },
      },
    });
    await post('/api/new', { seed: 2027, cfg: { turns: 8 } });
    const before = (await get('/api/state')).game;
    assert.equal(before.controllers.A.profileId, profileA);
    assert.equal(before.controllers.B.profileId, profileB);
    assert.equal(before.leaderboard.find(x => x.ai === 'A').model, '模型甲');
    assert.equal(before.leaderboard.find(x => x.ai === 'B').model, '模型乙');

    const n = requests.length;
    const r = await post('/api/step');
    assert.equal(r.ok, true);
    const q = Object.fromEntries(requests.slice(n).map(x => [x.url, x]));
    assert.equal(requests.length - n, 2, '本回合只该请求两份被选中的模型');
    assert.equal(q['/v1/chat/completions'].headers.authorization, `Bearer ${KEY_A}`);
    assert.equal(q['/v1/chat/completions'].body.model, 'model-a');
    assert.equal(q['/v2/chat/completions'].headers.authorization, `Bearer ${KEY_B}`);
    assert.equal(q['/v2/chat/completions'].body.model, 'model-b');
    assert.equal(r.game.llm.perAI.A.state, 'ok');
    assert.equal(r.game.llm.perAI.A.model, '模型甲');
    assert.equal(r.game.llm.perAI.B.model, '模型乙');
    assert.ok(!JSON.stringify(r.game).includes(KEY_A) && !JSON.stringify(r.game).includes(KEY_B), '快照不能有明文 Key');
  });

  await test('按模型单独测试连接：只打到该模型自己的端点', async () => {
    const n = requests.length;
    const r = await post('/api/llm/profiles/test', { id: profileB });
    assert.equal(r.ok, true, r.error);
    assert.equal(requests.length - n, 1);
    assert.equal(requests[n].url, '/v2/chat/completions');
    assert.equal(requests[n].headers.authorization, `Bearer ${KEY_B}`);
  });

  await test('缺 Key 的模型自动降级，且不串用默认模型的 Key', async () => {
    const c = await post('/api/llm/profiles', {
      name: '无密钥', provider: 'custom', apiKey: '',
      baseURL: `http://127.0.0.1:${MOCK_PORT}/v3`, model: 'model-c',
      makeDefault: false, persist: false,
    });
    assert.equal(c.ok, true, c.error);
    assert.equal(c.profile.hasKey, false);
    await post('/api/controllers', {
      controllers: {
        A: { mode: 'llm', strategy: 'auto', profileId: profileA },
        B: { mode: 'llm', strategy: 'auto', profileId: profileB },
        C: { mode: 'llm', strategy: 'auto', profileId: c.profile.id },
        D: { mode: 'bot', strategy: 'turtle' },
      },
    });
    const n = requests.length;
    const r = await post('/api/step');
    assert.equal(r.game.llm.perAI.C.state, 'nokey');
    assert.match(r.game.llm.perAI.C.error, /未配置 API Key/);
    assert.ok(!requests.slice(n).some(x => x.url.startsWith('/v3')), '缺 Key 的模型不该发出请求');
    assert.equal(requests.length - n, 2, '其余两家照常各用自己的模型');
  });

  await test('删除被引用的模型：引用自动清掉并退回默认模型，对局不中断', async () => {
    const r = await post('/api/llm/profiles/delete', { id: profileA });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.profiles.length, 2);
    assert.equal(r.defaultProfileId, profileB);
    const ctl = await get('/api/controllers');
    assert.equal(ctl.controllers.A.profileId, undefined, 'A 的失效引用应被清掉');
    assert.equal(ctl.controllers.B.profileId, profileB);
    const n = requests.length;
    const s = await post('/api/step');
    assert.equal(s.ok, true);
    assert.equal(s.game.llm.perAI.A.state, 'ok');
    assert.ok(!requests.slice(n).some(x => x.url.startsWith('/v1')), '不该再打到已删除模型的端点');
    assert.ok(!JSON.stringify(s.game).includes(KEY_A), '删除后快照更不该残留明文 Key');
  });

  await test('整局跑完写入历史战绩；.env 未被改动', async () => {
    await post('/api/auto', { interval: 50, seed: 2026, cfg: { turns: 8 } });
    for (let i = 0; i < 100; i++) {
      const g = (await get('/api/state')).game;
      if (g.over) break;
      await sleep(80);
    }
    const g = (await get('/api/state')).game;
    assert.equal(g.over, true);
    assert.equal(g.records.A.games >= 1, true);
    assert.ok(g.lastResult && g.lastResult.winner);
    assert.equal(readEnv(), envBefore, 'persist=false 不应改 .env');
  });

  console.log('\n端到端：对局记忆闭环');

  const promptText = n => JSON.stringify(requests.slice(n));
  const onlyA = {
    A: { mode: 'llm', strategy: 'auto' },
    B: { mode: 'bot', strategy: 'economist' },
    C: { mode: 'bot', strategy: 'fortress' },
    D: { mode: 'bot', strategy: 'turtle' },
  };

  await test('整局结束后战绩与复盘经验落盘，快照能读到', async () => {
    const m = await get('/api/memory');
    assert.equal(m.ok, true);
    assert.ok(m.totalMatches >= 1, '至少归档一局');
    assert.ok(m.stats.A.games >= 1);
    assert.ok(['A', 'B', 'C'].some(ai => m.lessons[ai].length > 0), '大模型势力应自动生成复盘经验');
    const g = (await get('/api/state')).game;
    assert.ok(g.memory && g.memory.totalMatches >= 1);
    assert.ok(g.records.A.games >= 1);
    assert.equal(typeof g.feedback.A, 'string');
  });

  await test('新一局首回合：提示词里出现历史记忆、跨局战绩与经验', async () => {
    await post('/api/controllers', { controllers: onlyA });
    await post('/api/new', { seed: 2031, cfg: { turns: 6 } });
    const n = requests.length;
    const r = await post('/api/step');
    assert.equal(r.ok, true);
    const text = promptText(n);
    assert.ok(text.includes('历史记忆'), 'prompt 应带记忆块');
    assert.ok(text.includes('跨局战绩'), 'prompt 应带跨局战绩');
    assert.ok(text.includes('累计'), 'prompt 应带累计场次');
    assert.ok(text.includes('过往经验') || text.includes('建议'), 'prompt 应带复盘经验');
  });

  await test('第二回合：提示词带上回合的动作与 Δ 结果', async () => {
    const n = requests.length;
    const r = await post('/api/step');
    const text = promptText(n);
    assert.ok(text.includes('上回合反馈'));
    assert.ok(text.includes('领土'));
    assert.ok(r.game.feedback.A.includes('你上回合'), '快照应暴露局内反馈');
  });

  await test('关掉记忆开关后提示词不再注入，战绩仍照常累计', async () => {
    const c = await post('/api/memory/config', { enabled: false });
    assert.equal(c.enabled, false);
    const n = requests.length;
    await post('/api/step');
    assert.ok(!promptText(n).includes('历史记忆'));
    await post('/api/memory/config', { enabled: true });
  });

  await test('手动大模型复盘：mock 返回 lessons 并写入经验库', async () => {
    const before = (await get('/api/memory')).lessons.A.length;
    mockContent = '```json\n{"lessons":["开局固定留 1 兵站基地格","远征前先让 2 号兵喝泉水"]}\n```';
    let r;
    try { r = await post('/api/memory/reflect', { ai: 'A' }); }
    finally { mockContent = '```json\n{"actions":[{"type":"produce"}]}\n```'; }
    assert.equal(r.ok, true, r.error);
    assert.equal(r.added.length, 2);
    assert.ok((await get('/api/memory')).lessons.A.length >= before);
  });

  await test('清空记忆后战绩归零，对局照常推进', async () => {
    const r = await post('/api/memory/clear');
    assert.equal(r.totalMatches, 0);
    assert.equal(r.stats.A.games, 0);
    const g = (await get('/api/state')).game;
    assert.equal(g.records.A.games, 0);
    const s = await post('/api/step');
    assert.equal(s.ok, true);
  });

  await test('畸形 JSON 返回统一错误结构，不再吐 HTML 堆栈', async () => {
    const resp = await fetch(`${BASE}/api/controllers`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
    });
    const text = await resp.text();
    assert.equal(resp.status, 400);
    assert.ok(!text.includes('<!DOCTYPE'), '不该返回 Express 默认 HTML 错误页');
    const j = JSON.parse(text);
    assert.equal(j.ok, false);
    assert.ok(typeof j.error === 'string' && j.error.length > 0);
  });
} catch (e) {
  console.error('集成测试启动失败：', e);
  fail++;
} finally {
  if (child) child.kill();
  mock.close();
  await sleep(120);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
