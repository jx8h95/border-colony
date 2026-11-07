// experiments/run-10000.mjs — 20 策略随机组合的万局批量模拟（独立脚本，不改项目现有代码）
//
// 用法：
//   node experiments/run-10000.mjs                        # 默认 10000 局 / 8 worker / seed 20261106
//   node experiments/run-10000.mjs --games 100 --workers 4 --out smoke.json
//
// 设计要点：
//  * 每局用「局号 + 主种子」推出自己的随机流，与 worker 数量、执行顺序完全无关 → 结果可复现。
//  * 每局从 20 个策略里无放回抽 4 个，再随机打乱分配到 A/B/C/D，避免位置偏差。
//  * 每局都跑到 game.over（征服胜或回合耗尽），不截断、不抽样。
//  * 逐局数据写 games.csv，汇总写 results.json；两份报告文档由 results.json 生成。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';

import {
  createGame, resolveTurn, getViewFor, AI_IDS, normalizeCfg, CELLS,
} from '../server/engine.js';
import { STRATEGIES20, BY_KEY, DIAG } from './strategies20.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 确定性随机 ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 主种子 + 局号 → 32 位种子；同样的输入永远给同样的地图与抽签 */
function mixSeed(master, i, salt = 0) {
  let h = (master ^ Math.imul(i + 1, 0x9E3779B1) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fisher-Yates：用给定 rng 原地洗牌前 n 个 */
function shuffle(arr, rng, n = arr.length) {
  const a = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/* ---------------- 单局 ---------------- */

const KEYS = STRATEGIES20.map(s => s.key);

function playOne(i, master) {
  const rng = mulberry32(mixSeed(master, i));
  const asg = shuffle(shuffle(KEYS, rng, 4), rng, 4);   // 抽 4 个 + 再打乱位置
  const seed = mixSeed(master, i, 0xA5A5A5A5);
  const game = createGame(seed, { cfg: normalizeCfg({}) });

  let turns = 0;
  while (!game.over) {
    const actions = {};
    for (let p = 0; p < 4; p++) {
      const ai = AI_IDS[p];
      if (!game.bases[ai].alive) { actions[ai] = []; continue; }
      actions[ai] = BY_KEY[asg[p]].buildActions(getViewFor(game, ai), game, ai);
    }
    resolveTurn(game, actions);
    if (++turns > game.maxTurns + 5) throw new Error(`局 ${i} 未能收敛: turn=${game.turn}`);
  }

  const mid = game.history[Math.min(60, game.history.length - 1)]?.territory || {};
  const winnerPos = AI_IDS.indexOf(game.winner);
  const cells = AI_IDS.map(a => game.territoryCount[a]);
  const sorted = [...cells].sort((a, b) => b - a);

  return {
    i, seed, asg,
    winnerPos, winnerKey: winnerPos >= 0 ? asg[winnerPos] : null,
    winType: game.winType, turns: game.turn,
    cells,
    midCells: AI_IDS.map(a => mid[a] ?? 0),
    units: AI_IDS.map(a => game.units.filter(u => u.alive && u.owner === a).length),
    kills: AI_IDS.map(a => game.kills[a]),
    stock: AI_IDS.map(a => game.stock[a]),
    dead: AI_IDS.map(a => game.bases[a].alive ? 0 : 1),
    coverage: +(cells.reduce((s, v) => s + v, 0) / CELLS).toFixed(4),
    margin: sorted[0] - sorted[1],
  };
}

/* ---------------- Worker ---------------- */

if (!isMainThread) {
  const { start, end, master } = workerData;
  const games = [];
  const errors = [];
  for (let i = start; i < end; i++) {
    try { games.push(playOne(i, master)); }
    catch (e) { errors.push({ i, message: e.message }); }
  }
  parentPort.postMessage({ games, errors, diagErrors: DIAG.errors });
} else {
  /* ---------------- 主进程 ---------------- */

  const argv = process.argv.slice(2);
  const argOf = (name, fallback) => {
    const k = argv.indexOf(name);
    return k !== -1 && argv[k + 1] ? argv[k + 1] : fallback;
  };
  const GAMES = Math.max(1, Number(argOf('--games', 10000)));
  const WORKERS = Math.max(1, Math.min(Number(argOf('--workers', 8)), os.cpus().length, GAMES));
  const MASTER = Number(argOf('--seed', 20261106)) >>> 0;
  const OUT = argOf('--out', 'results.json');

  console.log(`[run] ${GAMES} 局 · ${WORKERS} worker · seed=${MASTER} · 策略 ${STRATEGIES20.length} 个`);
  const t0 = performance.now();

  const chunks = [];
  for (let w = 0; w < WORKERS; w++) {
    const start = Math.floor(GAMES * w / WORKERS);
    const end = Math.floor(GAMES * (w + 1) / WORKERS);
    if (end > start) chunks.push({ start, end });
  }

  const results = await Promise.all(chunks.map(c => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { start: c.start, end: c.end, master: MASTER },
    });
    let done = false;
    worker.on('message', m => { done = true; resolve(m); });
    worker.on('error', e => { if (!done) reject(e); });
    worker.on('exit', code => { if (!done && code !== 0) reject(new Error(`worker 退出 code=${code}`)); });
  })));

  const games = results.flatMap(r => r.games).sort((a, b) => a.i - b.i);
  const errors = results.flatMap(r => r.errors);
  const diagErrors = results.reduce((s, r) => s + (r.diagErrors || 0), 0);
  const elapsed = Math.round(performance.now() - t0);

  if (errors.length || diagErrors || games.length !== GAMES) {
    console.error('[run] 未完成全部对局：', { completed: games.length, expected: GAMES, errors: errors.slice(0, 5), diagErrors });
    process.exitCode = 1;
  }

  /* ---------------- 汇总 ---------------- */

  const sum = (xs) => xs.reduce((s, v) => s + v, 0);
  const avg = (xs) => xs.length ? sum(xs) / xs.length : 0;
  const pct = (n, d) => d ? +(100 * n / d).toFixed(2) : 0;
  const round = (v, n = 2) => +v.toFixed(n);
  const ci = (p, n) => n ? round(196 * Math.sqrt((p / 100) * (1 - p / 100) / n), 2) : 0;

  const byKey = Object.fromEntries(KEYS.map(k => [k, {
    key: k, name: BY_KEY[k].name, family: BY_KEY[k].family,
    games: 0, wins: 0, cells: 0, midCells: 0, kills: 0, units: 0, stock: 0, dead: 0,
    rankSum: 0, conquestGames: 0, conquestWins: 0, earlyGames: 0,
    pos: Array.from({ length: 4 }, () => ({ games: 0, wins: 0, cells: 0 })),
  }]));

  const posGlobal = Array.from({ length: 4 }, () => ({ games: 0, wins: 0, cells: 0 }));
  const h2h = Object.fromEntries(KEYS.map(k => [k, Object.fromEntries(KEYS.map(t => [t, { games: 0, wins: 0 }]))]));
  const combos = new Map();
  const winTypes = { territory: 0, conquest: 0, 'mutual-destruction': 0 };
  const turnList = [];
  let deadFactions = 0, coverageSum = 0, marginSum = 0;

  for (const g of games) {
    winTypes[g.winType] = (winTypes[g.winType] || 0) + 1;
    turnList.push(g.turns);
    deadFactions += sum(g.dead);
    coverageSum += g.coverage;
    marginSum += g.margin;

    const rank = [...g.cells].map((v, p) => ({ v, p })).sort((a, b) => b.v - a.v);

    for (let p = 0; p < 4; p++) {
      const k = g.asg[p], s = byKey[k], won = g.winnerPos === p ? 1 : 0;
      s.games++; s.wins += won;
      s.cells += g.cells[p]; s.midCells += g.midCells[p];
      s.kills += g.kills[p]; s.units += g.units[p]; s.stock += g.stock[p];
      s.dead += g.dead[p];
      s.rankSum += rank.findIndex(r => r.p === p) + 1;
      if (g.winType === 'conquest') { s.conquestGames++; if (won) s.conquestWins++; }
      if (g.turns < 120) s.earlyGames++;
      s.pos[p].games++; s.pos[p].wins += won; s.pos[p].cells += g.cells[p];
      posGlobal[p].games++; posGlobal[p].wins += won; posGlobal[p].cells += g.cells[p];

      for (let q = 0; q < 4; q++) {
        if (q === p) continue;
        h2h[k][g.asg[q]].games++;
        if (won) h2h[k][g.asg[q]].wins++;
      }
    }

    const combo = [...g.asg].sort().join('+');
    const c = combos.get(combo) || { combo, games: 0, conquest: 0, turns: 0, coverage: 0 };
    c.games++; c.conquest += g.winType === 'conquest' ? 1 : 0;
    c.turns += g.turns; c.coverage += g.coverage;
    combos.set(combo, c);
  }

  const strategies = Object.values(byKey).map(s => {
    const winRate = pct(s.wins, s.games);
    return {
      ...s,
      winRate,
      ci95: ci(winRate, s.games),
      // 四个位置等权平均：消除基地位置差异造成的偏差
      adjWinRate: round(avg(s.pos.map(p => pct(p.wins, p.games)))),
      avgCells: round(s.cells / s.games, 1),
      avgMidCells: round(s.midCells / s.games, 1),
      avgLateGain: round((s.cells - s.midCells) / s.games, 1),
      avgKills: round(s.kills / s.games, 2),
      avgUnits: round(s.units / s.games, 2),
      avgStock: round(s.stock / s.games, 1),
      avgRank: round(s.rankSum / s.games, 2),
      deathRate: pct(s.dead, s.games),
      conquestRate: pct(s.conquestGames, s.games),
      conquestWinRate: pct(s.conquestWins, s.conquestGames),
      earlyRate: pct(s.earlyGames, s.games),
      pos: s.pos.map((p, i) => ({ pos: AI_IDS[i], games: p.games, winRate: pct(p.wins, p.games), avgCells: round(p.cells / p.games, 1) })),
    };
  }).sort((a, b) => b.adjWinRate - a.adjWinRate);

  const families = Object.values(strategies.reduce((acc, s) => {
    const f = acc[s.family] || (acc[s.family] = { family: s.family, n: 0, games: 0, wins: 0, cells: 0, kills: 0 });
    f.n++; f.games += s.games; f.wins += s.wins; f.cells += s.cells; f.kills += s.kills;
    return acc;
  }, {})).map(f => ({
    family: f.family, strategies: f.n, games: f.games,
    winRate: pct(f.wins, f.games),
    avgCells: round(f.cells / f.games, 1),
    avgKills: round(f.kills / f.games, 2),
  })).sort((a, b) => b.winRate - a.winRate);

  const sortedTurns = [...turnList].sort((a, b) => a - b);
  const comboList = [...combos.values()].map(c => ({
    combo: c.combo, games: c.games,
    conquestRate: pct(c.conquest, c.games),
    avgTurns: round(c.turns / c.games, 1),
    avgCoverage: round(c.coverage / c.games, 4),
  }));

  const pairRows = [];
  for (let a = 0; a < KEYS.length; a++) {
    for (let b = a + 1; b < KEYS.length; b++) {
      const ka = KEYS[a], kb = KEYS[b];
      const together = h2h[ka][kb].games;   // 两家同局的次数（对称）
      const wa = h2h[ka][kb].wins, wb = h2h[kb][ka].wins;
      if (together >= 1) {
        pairRows.push({
          a: ka, b: kb, games: together,
          aWinRate: pct(wa, together), bWinRate: pct(wb, together),
          gap: round(pct(wa, together) - pct(wb, together), 2),
        });
      }
    }
  }

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      masterSeed: MASTER, games: games.length, expectedGames: GAMES,
      workers: WORKERS, elapsedMs: elapsed,
      turnsPerGame: 120, map: '50x50', cells: CELLS,
      strategies: STRATEGIES20.length,
      sampling: '每局从 20 策略无放回抽 4 个，再随机分配到 A/B/C/D',
      engine: 'server/engine.js（未修改）',
      completed: games.length === GAMES && errors.length === 0 && diagErrors === 0,
      errors, diagErrors,
    },
    global: {
      winTypes: Object.fromEntries(Object.entries(winTypes).map(([k, v]) => [k, v])),
      winTypePct: Object.fromEntries(Object.entries(winTypes).map(([k, v]) => [k, pct(v, games.length)])),
      avgTurns: round(avg(turnList), 2),
      medianTurns: sortedTurns[Math.floor(sortedTurns.length / 2)] ?? 0,
      minTurns: sortedTurns[0] ?? 0, maxTurns: sortedTurns[sortedTurns.length - 1] ?? 0,
      earlyFinishRate: pct(turnList.filter(t => t < 120).length, games.length),
      avgDeadFactions: round(deadFactions / games.length, 3),
      anyDeathRate: pct(games.filter(g => sum(g.dead) > 0).length, games.length),
      avgCoverage: round(coverageSum / games.length, 4),
      avgMargin: round(marginSum / games.length, 1),
      uniqueCombos: combos.size,
    },
    positions: posGlobal.map((p, i) => ({ pos: AI_IDS[i], games: p.games, winRate: pct(p.wins, p.games), avgCells: round(p.cells / p.games, 1) })),
    strategies,
    families,
    h2h,
    pairs: pairRows,
    combos: {
      total: combos.size,
      mostCommon: [...comboList].sort((a, b) => b.games - a.games).slice(0, 10),
      mostConquest: comboList.filter(c => c.games >= 3).sort((a, b) => b.conquestRate - a.conquestRate).slice(0, 10),
      fastest: comboList.filter(c => c.games >= 3).sort((a, b) => a.avgTurns - b.avgTurns).slice(0, 10),
      slowest: comboList.filter(c => c.games >= 3).sort((a, b) => b.avgTurns - a.avgTurns).slice(0, 10),
    },
  };

  fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(report, null, 2), 'utf8');

  // 逐局原始记录，便于复核 / 外部分析
  const csvPath = path.join(__dirname, OUT.replace(/\.json$/, '') + '-games.csv');
  const head = 'i,seed,A,B,C,D,winnerPos,winnerKey,winType,turns,' +
    'cellsA,cellsB,cellsC,cellsD,midA,midB,midC,midD,unitsA,unitsB,unitsC,unitsD,' +
    'killsA,killsB,killsC,killsD,stockA,stockB,stockC,stockD,deadA,deadB,deadC,deadD,coverage,margin';
  const rows = games.map(g => [
    g.i, g.seed, ...g.asg, g.winnerPos, g.winnerKey, g.winType, g.turns,
    ...g.cells, ...g.midCells, ...g.units, ...g.kills, ...g.stock, ...g.dead, g.coverage, g.margin,
  ].join(','));
  fs.writeFileSync(csvPath, [head, ...rows].join('\n') + '\n', 'utf8');

  console.log(`[run] 完成 ${games.length}/${GAMES} 局，耗时 ${(elapsed / 1000).toFixed(1)}s，异常 ${errors.length}，策略内部异常 ${diagErrors}`);
  console.log(`[run] 汇总 -> ${OUT} ；逐局 -> ${path.basename(csvPath)}`);
  console.log('\n=== 策略强度（位置等权胜率）===');
  for (const s of strategies) {
    console.log(`${s.key.padEnd(10)} ${String(s.adjWinRate).padStart(6)}%  (raw ${String(s.winRate).padStart(5)}% ±${s.ci95})  领土 ${String(s.avgCells).padStart(6)}  击杀 ${String(s.avgKills).padStart(5)}  亡国 ${s.deathRate}%  样本 ${s.games}`);
  }
  console.log('\n=== 全局 ===');
  console.log(JSON.stringify(report.global, null, 2));
}
