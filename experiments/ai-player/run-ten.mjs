// experiments/ai-player/run-ten.mjs
// 可一键复现的 driver：完全复刻 server/gameLoop.js 的 collectActions 循环
//   createGame(seed) → 每回合对四家取 getViewFor → 生成 actionsByAI → resolveTurn → 直到 game.over
// B/C/D 直接调 STRATEGIES[key].buildActions(view, game, ai)，A 调 player.mjs 的 buildActions(view, game, ai, version)。
// 走本地引擎离线模拟，不访问 3000 端口、不联网、不改任何现有代码。
//
// 用法：
//   node run-ten.mjs                 → 完整：10 主局(按 PLAN) + 30 基线 → results.csv（40 行数据）+ 汇总
//   node run-ten.mjs --baselines    → 只跑 3 组基线，打印汇总（迭代期了解局面，不写 csv）
//   node run-ten.mjs --probe G V    → 只跑第 G 局(1..10)、A 用 version V，打印逐局详细复盘数据
//   node run-ten.mjs --final V      → 10 个 seed 全用固定 version V 跑，打印「能力上限」参考（不写 csv）
//
// 统计口径统一：A 名次 / A 领土 / A 存活兵 / A 击杀 / A 采集 / A 累计 lastRejected.A / 胜者与胜法 / 结束回合 / 四家终局领土。

import { createGame, getViewFor, resolveTurn, AI_IDS, aliveCount, factionAlive } from '../../server/engine.js';
import { STRATEGIES } from '../../server/bots.js';
import { buildActions as playerActions } from './player.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results.csv');

const SEEDS = [20261106, 1001, 2002, 3003, 4004, 5005, 6006, 7007, 8008, 9009];

// 每局使用哪个版本的打法（1..4）。这是「连打 10 局、局间复盘迭代」的正式记录：
//   第 1 局   v1 首版（探索）：输了 → 复盘「兵全灭、领土崩」→ 改出 v2
//   第 2~4 局 v2（第 1 次迭代成果）：全胜但 blocked 5.6/局 → 复盘 → 改出 v3
//   第 5~7 局 v3（第 2 次迭代成果）：blocked 归零但领土/兵略降 → 复盘 → 改出 v4
//   第 8~10 局 v4（第 3 次迭代成果，定稿）
// 共 3 次迭代、4 个版本，与 player.mjs 的 VERSIONS 一起按 version 参数可完整复现。
const PLAN = [1, 2, 2, 2, 3, 3, 3, 4, 4, 4];

// 对手固定，不许动：B=economist（默认最强）、C=fortress、D=turtle
const OPP = { B: 'economist', C: 'fortress', D: 'turtle' };

// 三组基线（同 seed 各 10 局）。注意用户列出的「A 换 aggressive」与「四家全默认」
// 在默认配置下是同一套 assignment，仍如实各跑 10 局、不擅自合并。
const BASELINES = [
  { group: 'base_aggressive', A: 'aggressive', ...OPP },
  { group: 'base_economist',  A: 'economist',  ...OPP },
  { group: 'base_default',    A: 'aggressive', ...OPP },
];

const CSV_COLS = [
  'group', 'game', 'seed', 'version',
  'rankA', 'terrA', 'unitsA', 'killsA', 'harvestedA', 'rejInvalidA', 'rejBlockedA',
  'winner', 'winType', 'turns',
  'terrB', 'terrC', 'terrD', 'unitsB', 'unitsC', 'unitsD',
  'aliveA', 'aliveB', 'aliveC', 'aliveD',
];

/* ---------------- 单局：复刻官方 collectActions 循环 ---------------- */
function playOne(seed, assignment, version, collectA = false) {
  const game = createGame(seed);            // 默认 cfg、120 回合上限
  const acc = {
    rejInvalidA: 0, rejBlockedA: 0,
    produce: 0, harvest: 0, act: {},
    notable: [],
  };
  let guard = 0;
  while (!game.over && guard++ < 1000) {
    const actionsByAI = {};
    for (const ai of AI_IDS) {
      const view = getViewFor(game, ai);
      if (ai === 'A') {
        // 累计「AI 玩家每回合实际收到的 lastRejected.A 反馈」之和
        const r = (view.lastRejected && view.lastRejected.A) || { invalid: 0, blocked: 0 };
        acc.rejInvalidA += r.invalid || 0;
        acc.rejBlockedA += r.blocked || 0;
      }
      actionsByAI[ai] = assignment[ai] === 'PLAYER'
        ? playerActions(view, game, ai, version)
        : STRATEGIES[assignment[ai]].buildActions(view, game, ai);
    }
    if (collectA) {
      for (const a of (actionsByAI.A || [])) {
        if (a.type === 'produce') acc.produce++;
        else if (a.type === 'harvest') acc.harvest++;
        else acc.act[a.type] = (acc.act[a.type] || 0) + 1;
      }
    }
    resolveTurn(game, actionsByAI);
    if (collectA) {
      for (const e of (game.events || [])) {
        if (/亡国|攻陷|包围夺取/.test(e)) acc.notable.push(`T${game.turn} ${e}`);
      }
    }
  }
  return { game, acc };
}

/* ---------------- 统一名次口径（与引擎 rankByTerritory 同序）---------------- */
function rankOf(game, ai) {
  const order = [...AI_IDS].sort((a, b) =>
    game.territoryCount[b] - game.territoryCount[a] ||
    aliveCount(game, b) - aliveCount(game, a) ||
    game.scores[b] - game.scores[a] ||
    game.kills[b] - game.kills[a]);
  return order.indexOf(ai) + 1;
}

function summarize(game, acc, meta) {
  return {
    ...meta,
    rankA: rankOf(game, 'A'),
    terrA: game.territoryCount.A,
    unitsA: aliveCount(game, 'A'),
    killsA: game.kills.A,
    harvestedA: game.scores.A,
    rejInvalidA: acc.rejInvalidA,
    rejBlockedA: acc.rejBlockedA,
    winner: game.winner,
    winType: game.winType,
    turns: game.turn,
    terrB: game.territoryCount.B,
    terrC: game.territoryCount.C,
    terrD: game.territoryCount.D,
    unitsB: aliveCount(game, 'B'),
    unitsC: aliveCount(game, 'C'),
    unitsD: aliveCount(game, 'D'),
    aliveA: factionAlive(game, 'A') ? 1 : 0,
    aliveB: factionAlive(game, 'B') ? 1 : 0,
    aliveC: factionAlive(game, 'C') ? 1 : 0,
    aliveD: factionAlive(game, 'D') ? 1 : 0,
  };
}

function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function avg(rows, k) {
  return rows.length ? rows.reduce((s, r) => s + Number(r[k]), 0) / rows.length : 0;
}

function printAgg(label, rows) {
  const wins = rows.filter(r => r.rankA === 1).length;
  const conq = rows.filter(r => r.winner === 'A' && r.winType === 'conquest').length;
  console.log(
    `${label.padEnd(22)} 局数=${String(rows.length).padStart(2)}` +
    ` 胜(A第1)=${wins} 征服胜=${conq}` +
    ` 平均名次=${avg(rows, 'rankA').toFixed(2)}` +
    ` 平均领土=${avg(rows, 'terrA').toFixed(1)}` +
    ` 平均兵=${avg(rows, 'unitsA').toFixed(2)}` +
    ` 平均击杀=${avg(rows, 'killsA').toFixed(2)}` +
    ` 平均采集=${avg(rows, 'harvestedA').toFixed(1)}` +
    ` 平均被拒(inv/blk)=${avg(rows, 'rejInvalidA').toFixed(2)}/${avg(rows, 'rejBlockedA').toFixed(2)}`
  );
}

/* ---------------- 主局 / 基线 ---------------- */
function runPlayer(plan) {
  const rows = [];
  for (let i = 0; i < SEEDS.length; i++) {
    const version = plan[i];
    const assignment = { A: 'PLAYER', ...OPP };
    const { game, acc } = playOne(SEEDS[i], assignment, version);
    rows.push(summarize(game, acc, {
      group: 'player', game: i + 1, seed: SEEDS[i], version,
    }));
  }
  return rows;
}

function runBaselines() {
  const rows = [];
  for (const b of BASELINES) {
    for (let i = 0; i < SEEDS.length; i++) {
      const assignment = { A: b.A, B: b.B, C: b.C, D: b.D };
      const { game, acc } = playOne(SEEDS[i], assignment, 0);
      rows.push(summarize(game, acc, {
        group: b.group, game: i + 1, seed: SEEDS[i], version: '-',
      }));
    }
  }
  return rows;
}

/* ---------------- 探测模式：单局详细复盘数据 ---------------- */
function probe(gameNo, version) {
  const i = gameNo - 1;
  if (i < 0 || i >= SEEDS.length) { console.error('局号须在 1..10'); process.exit(1); }
  const assignment = { A: 'PLAYER', ...OPP };
  const { game, acc } = playOne(SEEDS[i], assignment, version, true);
  const s = summarize(game, acc, { group: 'probe', game: gameNo, seed: SEEDS[i], version });
  console.log(`\n===== PROBE 第 ${gameNo} 局 seed=${SEEDS[i]} version=${version} =====`);
  console.log(`A 名次=${s.rankA} 领土=${s.terrA} 兵=${s.unitsA} 击杀=${s.killsA} 采集=${s.harvestedA}`);
  console.log(`胜者=${s.winner} 方式=${s.winType} 结束回合=${s.turns} 存活=${s.aliveA}${s.aliveB}${s.aliveC}${s.aliveD}`);
  console.log(`四家终局领土 A=${s.terrA} B=${s.terrB} C=${s.terrC} D=${s.terrD}`);
  console.log(`四家终局兵   A=${s.unitsA} B=${s.unitsB} C=${s.unitsC} D=${s.unitsD}`);
  console.log(`A 被拒累计 invalid=${acc.rejInvalidA} blocked=${acc.rejBlockedA}`);
  console.log(`A 动作统计 produce=${acc.produce} harvest=${acc.harvest} ` +
    Object.entries(acc.act).map(([k, v]) => `${k}=${v}`).join(' '));
  // 领土曲线：每 20 回合 A 与当前第一名的领土
  const h = game.history || [];
  const curve = [];
  for (let t = 0; t < h.length; t += 20) {
    const terr = h[t].territory;
    const lead = Math.max(...AI_IDS.map(a => terr[a]));
    curve.push(`T${String(h[t].turn).padStart(3)}:A=${String(terr.A).padStart(4)}(lead=${lead})`);
  }
  curve.push(`T${String(game.turn).padStart(3)}:A=${s.terrA}(lead=${Math.max(s.terrA, s.terrB, s.terrC, s.terrD)})`);
  console.log('领土曲线 ' + curve.join('  '));
  const notable = acc.notable.slice(0, 24);
  console.log(`关键事件(${acc.notable.length}) ${notable.join(' | ') || '无'}`);
}

/* ---------------- 最终版本单跑（能力上限参考，不写 csv）---------------- */
function finalRun(version) {
  const rows = runPlayer(new Array(SEEDS.length).fill(version));
  console.log(`\n===== FINAL 全 10 seed 固定 version=${version} =====`);
  for (const r of rows) {
    console.log(` 第${String(r.game).padStart(2)}局 seed=${r.seed} 名次=${r.rankA} 领土=${r.terrA} 兵=${r.unitsA} 击杀=${r.killsA} 被拒=${r.rejInvalidA}/${r.rejBlockedA} 胜者=${r.winner}/${r.winType} 回合=${r.turns} 四家=${r.terrA}/${r.terrB}/${r.terrC}/${r.terrD}`);
  }
  printAgg(`final v${version}`, rows);
}

/* ---------------- 完整运行 ---------------- */
function full() {
  const playerRows = runPlayer(PLAN);
  const baseRows = runBaselines();
  const all = [...playerRows, ...baseRows];
  const lines = [CSV_COLS.join(',')];
  for (const r of all) lines.push(CSV_COLS.map(c => csvEscape(r[c])).join(','));
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  console.log(`\n===== 完整运行：results.csv 写入 ${all.length} 行数据（10 主局 + 30 基线）=====`);
  console.log('PLAN(每局版本) = ' + PLAN.join(','));
  printAgg('player(迭代10局)', playerRows);
  for (const b of BASELINES) printAgg(b.group, baseRows.filter(r => r.group === b.group));

  console.log('\n--- 主局逐局 ---');
  for (const r of playerRows) {
    console.log(` 第${String(r.game).padStart(2)}局 seed=${r.seed} v${r.version} 名次=${r.rankA} 领土=${r.terrA} 兵=${r.unitsA} 击杀=${r.killsA} 采集=${r.harvestedA} 被拒=${r.rejInvalidA}/${r.rejBlockedA} 胜者=${r.winner}/${r.winType} 回合=${r.turns} 四家=${r.terrA}/${r.terrB}/${r.terrC}/${r.terrD}`);
  }
  console.log(`\nresults.csv 数据行 = ${all.length}（应为 40）`);
}

/* ---------------- 参数解析 ---------------- */
const argv = process.argv.slice(2);
if (argv[0] === '--baselines') {
  const rows = runBaselines();
  for (const b of BASELINES) printAgg(b.group, rows.filter(r => r.group === b.group));
} else if (argv[0] === '--probe') {
  probe(Number(argv[1]), Number(argv[2]));
} else if (argv[0] === '--final') {
  finalRun(Number(argv[1]));
} else {
  full();
}
