// test/memory.mjs — v6.4 对局记忆单测（纯函数 + 落盘 + 提示词注入）
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createGame, resolveTurn, getViewFor, normalizeCfg, AI_IDS,
} from '../server/engine.js';
import { STRATEGIES } from '../server/bots.js';
import { buildPrompt, styleFor } from '../server/gameLoop.js';
import {
  freshMemory, normalizeMemory, summarizeMatch, annotateCauses, deriveLessons,
  buildFeedback, buildRecall, buildReflectPrompt, statsFor, rankedLessons, MatchMemory,
  MAX_MATCHES, RECALL_CHAR_LIMIT,
} from '../server/memory.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const STRATS = ['aggressive', 'economist', 'fortress', 'turtle'];
function playGame(seed = 7, turns = 24) {
  const game = createGame(seed, { cfg: normalizeCfg({ turns }) });
  while (!game.over) {
    const acts = {};
    AI_IDS.forEach((ai, i) => {
      acts[ai] = STRATEGIES[STRATS[i]].buildActions(getViewFor(game, ai), game, ai);
    });
    resolveTurn(game, acts);
  }
  return game;
}
const llmControllers = () => Object.fromEntries(
  AI_IDS.map(ai => [ai, { mode: 'llm', strategy: 'auto', model: 'mock-model' }])
);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-')), 'memory.json');

console.log('\n== 归一化 ==');

test('空 / 损坏输入都能得到干净结构', () => {
  for (const raw of [null, undefined, 'bad', 42, { matches: 'oops', lessons: 9 }]) {
    const m = normalizeMemory(raw);
    assert.equal(m.enabled, true);
    assert.deepEqual(m.matches, []);
    assert.deepEqual(Object.keys(m.lessons).sort(), [...AI_IDS].sort());
  }
});

test('非法字段被夹紧，经验文本被清洗', () => {
  const m = normalizeMemory({
    enabled: false, reflectEnabled: false, maxLessons: 999,
    matches: [{ perAI: { A: { rank: 99, territory: -5, pct: 500 } } }],
    lessons: { A: [{ text: '  留  一兵  守家  ', uses: -3, kind: 'weird' }, { text: '' }] },
  });
  assert.equal(m.enabled, false);
  assert.equal(m.maxLessons, 12);
  assert.equal(m.matches[0].perAI.A.rank, 4);
  assert.equal(m.matches[0].perAI.A.territory, 0);
  assert.equal(m.matches[0].perAI.A.pct, 100);
  assert.equal(m.lessons.A.length, 1);
  assert.equal(m.lessons.A[0].text, '留 一兵 守家');
  assert.equal(m.lessons.A[0].kind, 'rule');
  assert.equal(m.lessons.A[0].uses, 0);
});

console.log('\n== 对局摘要与复盘 ==');

const game = playGame();
const match = annotateCauses(summarizeMatch(game, { serial: 1, controllers: llmControllers() }));

test('摘要含四家、名次唯一、胜者标记正确', () => {
  assert.deepEqual(Object.keys(match.perAI).sort(), [...AI_IDS].sort());
  assert.equal(new Set(AI_IDS.map(a => match.perAI[a].rank)).size, 4);
  assert.equal(match.perAI[match.winner].won, true);
  assert.equal(match.winner, game.winner);
  assert.equal(match.turn, game.turn);
  assert.equal(match.winType, game.winType);
});

test('领土曲线字段自洽：峰值 ≥ 终值，分段增量之和≈终值-初值', () => {
  for (const ai of AI_IDS) {
    const p = match.perAI[ai];
    assert.ok(p.peak >= p.territory, `${ai} peak`);
    assert.equal(p.endDrop, p.peak - p.territory);
    assert.equal(typeof p.avgGain, 'number');
    assert.ok(Number.isInteger(p.earlyGain) && Number.isInteger(p.lateGain));
  }
});

test('败因只标在败局，且是可读短语', () => {
  for (const ai of AI_IDS) {
    const p = match.perAI[ai];
    if (p.won) assert.deepEqual(p.causes, []);
    for (const c of p.causes) assert.ok(typeof c === 'string' && c.length <= 40);
  }
});

test('deriveLessons 每家 ≤3 条、非空、句子可执行、无重复', () => {
  for (const ai of AI_IDS) {
    const ls = deriveLessons(match, ai);
    assert.ok(ls.length > 0 && ls.length <= 3, `${ai} 条数 ${ls.length}`);
    assert.equal(new Set(ls).size, ls.length);
    for (const l of ls) assert.ok(l.length > 12 && l.length <= 220);
  }
});

test('胜者与败者的复盘结论不同', () => {
  const win = match.winner;
  const lose = AI_IDS.find(a => a !== win);
  assert.ok(deriveLessons(match, win).some(l => l.includes('获胜')));
  assert.ok(!deriveLessons(match, lose).some(l => l.includes('获胜')));
});

test('亡国 / 大幅失地会给出针对性建议', () => {
  const fake = summarizeMatch(game, { controllers: llmControllers() });
  fake.perAI.A.alive = false;
  fake.perAI.A.diedAt = 12;
  fake.perAI.A.peak = 900;
  fake.perAI.A.territory = 100;
  fake.perAI.A.endDrop = 800;
  fake.perAI.A.won = false;
  const ls = deriveLessons(fake, 'A').join(' ');
  assert.ok(ls.includes('亡国') || ls.includes('主基地'));
  assert.ok(ls.includes('包围') || ls.includes('驻军'));
});

test('buildReflectPrompt 含结构化数据与规则要点', () => {
  const p = buildReflectPrompt(match, 'A');
  assert.ok(p.includes('"you": "A"'));
  assert.ok(p.includes('"standings"'));
  assert.ok(p.includes('包围'));
  assert.ok(p.includes('{"lessons"'));
  assert.equal(buildReflectPrompt(match, 'Z'), '');
});

console.log('\n== 局内反馈与召回 ==');

test('buildFeedback 的 Δ 与动作统计正确', () => {
  const s = buildFeedback(
    { territory: 100, units: 4, stock: 10, kills: 1, baseHp: 20 },
    { territory: 138, units: 3, stock: 4, kills: 2, baseHp: 20 },
    [{ type: 'move' }, { type: 'move' }, { type: 'harvest' }],
    ['A03 阵亡', 'A 包围夺取 24 格']
  );
  assert.ok(s.includes('领土 +38'));
  assert.ok(s.includes('士兵 -1'));
  assert.ok(s.includes('资源 -6'));
  assert.ok(s.includes('击杀 +1'));
  assert.ok(s.includes('行军×2'));
  assert.ok(s.includes('采集×1'));
  assert.ok(s.includes('A03 阵亡'));
});

test('禁用记忆时不注入；空记忆也不注入', () => {
  const m = freshMemory();
  assert.equal(buildRecall(m, 'A'), '');
  m.enabled = false;
  m.matches = [match];
  assert.equal(buildRecall(m, 'A', { feedback: '上回合领土 +5' }), '');
  assert.ok(buildRecall(m, 'A', { force: true }).includes('跨局战绩'));
});

test('召回块含反馈、战绩、败因与经验，且长度受限', () => {
  const m = freshMemory();
  m.matches = [match, match, match];
  m.lessons.A = [{ id: 'l1', text: '开局留 1 兵站基地格，别全员远征。', uses: 3, winAfter: 2, hits: 1 }];
  const r = buildRecall(m, 'A', { feedback: '上回合领土 +38、士兵 -1。' });
  assert.ok(r.includes('【历史记忆 · 势力 A】'));
  assert.ok(r.includes('【上回合反馈】'));
  assert.ok(r.includes('【跨局战绩】'));
  assert.ok(r.includes('【最近 3 局】'));
  assert.ok(r.includes('【过往经验'));
  assert.ok(r.includes('开局留 1 兵'));
  assert.ok(r.length <= RECALL_CHAR_LIMIT);
});

test('超长记忆被截断且带提示', () => {
  const m = freshMemory();
  m.matches = Array.from({ length: 5 }, () => match);
  m.lessons.A = Array.from({ length: 3 }, (_, i) => ({
    id: `l${i}`, text: '经验'.repeat(180), uses: 1, winAfter: 0, hits: 1,
  }));
  const r = buildRecall(m, 'A');
  assert.ok(r.length <= RECALL_CHAR_LIMIT);
  assert.ok(r.includes('记忆已截断'));
});

test('statsFor 区分累计与大模型操控的胜率', () => {
  const m = freshMemory();
  const botMatch = annotateCauses(summarizeMatch(game, { controllers: {} }));
  m.matches = [match, botMatch];
  const s = statsFor(m, 'A');
  assert.equal(s.games, 2);
  assert.equal(s.llmGames, 1);
  assert.ok(s.avgRank >= 1 && s.avgRank <= 4);
  assert.ok(s.recent.length <= 5);
});

test('rankedLessons 让高胜率经验排前面', () => {
  const list = [
    { id: 'a', text: 'a', uses: 10, winAfter: 0, hits: 1, at: null },
    { id: 'b', text: 'b', uses: 4, winAfter: 4, hits: 1, at: null },
  ];
  assert.equal(rankedLessons(list)[0].id, 'b');
});

test('buildPrompt 第三参把记忆插在状态与输出格式之间', () => {
  const view = getViewFor(game, 'A');
  const plain = buildPrompt(view, styleFor('auto'));
  const withMem = buildPrompt(view, styleFor('auto'), '【测试记忆】别全员远征。');
  assert.ok(!plain.includes('【测试记忆】'));
  assert.ok(withMem.includes('【测试记忆】'));
  assert.ok(withMem.indexOf('【测试记忆】') < withMem.indexOf('只输出一个 JSON 对象'));
  assert.ok(withMem.includes('"note"'));
});

console.log('\n== 持久化与经验有效性 ==');

test('归档落盘、跨实例恢复、records 累计', () => {
  const file = tmpFile();
  const a = new MatchMemory(file);
  a.record(game, { serial: 1, controllers: llmControllers() });
  a.record(game, { serial: 2, controllers: llmControllers() });
  assert.equal(a.publicView().totalMatches, 2);
  assert.equal(a.recordsView().A.games, 2);

  const b = new MatchMemory(file);
  assert.equal(b.publicView().totalMatches, 2);
  assert.equal(b.recordsView().A.games, 2);
  assert.equal(b.recordsView().A.wins, a.recordsView().A.wins);
});

test('复盘经验只给大模型势力生成，脚本势力不污染', () => {
  const m = new MatchMemory(tmpFile());
  const mixed = Object.fromEntries(AI_IDS.map((ai, i) => [ai,
    i === 0 ? { mode: 'llm', strategy: 'auto' } : { mode: 'bot', strategy: STRATS[i] }]));
  m.record(game, { serial: 1, controllers: mixed });
  assert.ok(m.publicView().lessons.A.length > 0);
  assert.equal(m.publicView().lessons.B.length, 0);
});

test('经验按文本去重、受 maxLessons 限制', () => {
  const m = new MatchMemory(tmpFile());
  m.setConfig({ maxLessons: 2 });
  for (let i = 0; i < 5; i++) m.addLesson('A', `第 ${i} 条建议`);
  m.addLesson('A', '第 4 条建议');
  assert.equal(m.publicView().lessons.A.length, 2);

  const one = new MatchMemory(tmpFile());
  one.addLesson('B', '留 1 兵守家');
  one.addLesson('B', '留 1 兵守家');
  assert.equal(one.publicView().lessons.B.length, 1);
  assert.equal(one.publicView().lessons.B[0].hits, 2);
});

test('注入过的经验会在下一局结算时回写 uses / winAfter', () => {
  const m = new MatchMemory(tmpFile());
  m.setConfig({ reflectEnabled: false });
  m.addLesson('A', '留 1 兵守家');
  const id = m.publicView().lessons.A[0].id;
  m.recall('A', '上回合领土 +5');
  const winner = game.winner;
  m.record(game, { serial: 1, controllers: llmControllers() });
  const l = m.publicView().lessons.A.find(x => x.id === id);
  assert.equal(l.uses, 1);
  assert.equal(l.winAfter, winner === 'A' ? 1 : 0);
  assert.ok(m.lastMatch().perAI.A.usedLessons.includes(id));
});

test('最多保留 60 局，最早那局被挤掉', () => {
  const m = new MatchMemory(tmpFile());
  m.setConfig({ reflectEnabled: false });
  for (let i = 0; i < MAX_MATCHES + 5; i++) {
    m.record(game, { serial: i, controllers: {} });
  }
  assert.equal(m.publicView().totalMatches, MAX_MATCHES);
  assert.equal(m.lastMatch().serial, MAX_MATCHES + 4);
});

test('clear 清战绩与经验但保留开关配置', () => {
  const m = new MatchMemory(tmpFile());
  m.setConfig({ enabled: false, maxLessons: 4 });
  m.record(game, { serial: 1, controllers: llmControllers() });
  m.clear();
  const v = m.publicView();
  assert.equal(v.totalMatches, 0);
  assert.equal(v.enabled, false);
  assert.equal(v.maxLessons, 4);
  assert.deepEqual(v.lessons.A, []);
});

test('损坏的落盘文件不会让服务起不来，且先备份原文件', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const m = new MatchMemory(file);
  assert.equal(m.publicView().totalMatches, 0);
  const backups = fs.readdirSync(path.dirname(file))
    .filter(n => n.startsWith(`${path.basename(file)}.corrupt-`));
  assert.equal(backups.length, 1, '损坏文件应改名备份，而不是被静默清空');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
