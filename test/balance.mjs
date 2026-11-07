// test/balance.mjs — 自动对局回归：跑多局统计胜率 / 覆盖 / 亡国率，用来调参数
import assert from 'assert/strict';
import { createGame, resolveTurn, getViewFor, AI_IDS, CELLS, normalizeCfg, displayRanking, CFG_LIMITS } from '../server/engine.js';
import { STRATEGIES } from '../server/bots.js';

const STRATS = ['aggressive', 'economist', 'fortress', 'turtle'];

function playOne(seed, cfg) {
  const game = createGame(seed, { cfg: normalizeCfg(cfg) });
  const assign = Object.fromEntries(AI_IDS.map((ai, i) => [ai, STRATS[i]]));
  let springTurns = 0, unitTurns = 0;

  while (!game.over) {
    const acts = {};
    for (const ai of AI_IDS) {
      const view = getViewFor(game, ai);
      const s = STRATEGIES[assign[ai]];
      acts[ai] = s.buildActions(view, game, ai);
      for (const u of view.units) {
        unitTurns++;
        if (u.spring > 0) springTurns++;
      }
    }
    resolveTurn(game, acts);
  }

  return {
    seed,
    winner: game.winner,
    winType: game.winType,
    turns: game.turn,
    cover: AI_IDS.reduce((s, a) => s + game.territoryCount[a], 0) / CELLS,
    dead: AI_IDS.filter(a => !game.bases[a].alive).length,
    units: AI_IDS.reduce((s, a) => s + game.units.filter(u => u.alive && u.owner === a).length, 0),
    kills: AI_IDS.reduce((s, a) => s + game.kills[a], 0),
    harvest: AI_IDS.reduce((s, a) => s + game.scores[a], 0),
    springRate: unitTurns ? springTurns / unitTurns : 0,
    spread: Math.max(...AI_IDS.map(a => game.territoryCount[a])) - Math.min(...AI_IDS.map(a => game.territoryCount[a])),
  };
}

const N = Number(process.env.N || 12);
const cfg = {};
const norm = k => k.toLowerCase().replace(/_/g, '');
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith('CFG_')) continue;
  const want = norm(k.slice(4));
  const hit = Object.keys(CFG_LIMITS).find(x => norm(x) === want);
  if (hit) cfg[hit] = Number(v);
}

const rows = [];
for (let i = 0; i < N; i++) rows.push(playOne(1000 + i * 37, cfg));

const wins = Object.fromEntries(AI_IDS.map(a => [a, 0]));
for (const r of rows) if (r.winner) wins[r.winner]++;

const avg = f => (rows.reduce((s, r) => s + f(r), 0) / rows.length);
const pct = v => (v * 100).toFixed(1) + '%';

console.log('\n# | 胜者 | 方式        | 回合 | 覆盖  | 亡国 | 存活兵 | 击杀 | 采集 | 泉水覆盖');
console.log('--+------+-------------+------+-------+------+--------+------+------+---------');
rows.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(2)} |  ${r.winner}   | ${String(r.winType).padEnd(11)} | ${String(r.turns).padStart(4)} | ${pct(r.cover).padStart(5)} |  ${r.dead}   |  ${String(r.units).padStart(4)}  | ${String(r.kills).padStart(4)} | ${String(r.harvest).padStart(4)} | ${pct(r.springRate).padStart(6)}`
  );
});

console.log('\n统计');
console.log(`  胜场分布  ${AI_IDS.map(a => `${a}:${wins[a]}`).join('  ')}`);
console.log(`  平均覆盖  ${pct(avg(r => r.cover))}`);
console.log(`  征服胜率  ${pct(rows.filter(r => r.winType === 'conquest').length / rows.length)}`);
console.log(`  平均亡国  ${avg(r => r.dead).toFixed(1)} / 4`);
console.log(`  平均击杀  ${avg(r => r.kills).toFixed(1)}   平均采集 ${avg(r => r.harvest).toFixed(0)}`);
console.log(`  泉水覆盖  ${pct(avg(r => r.springRate))}（有泉水加成的士兵回合占比）`);
console.log(`  强弱差    ${avg(r => r.spread).toFixed(0)} 格`);

/* 健全性基线：不做脆弱的黄金数值快照（规则一改就误报），
   只保证每局真的跑完、状态自洽，并且同 seed 完全可复现。 */
const maxTurns = normalizeCfg(cfg).turns;
for (const r of rows) {
  assert.ok(AI_IDS.includes(r.winner), `seed ${r.seed} 没有合法胜者`);
  assert.ok(['territory', 'conquest'].includes(r.winType), `seed ${r.seed} 胜利方式异常`);
  assert.ok(r.turns > 0 && r.turns <= maxTurns, `seed ${r.seed} 回合数越界：${r.turns}`);
  assert.ok(r.cover > 0 && r.cover <= 1, `seed ${r.seed} 领土覆盖率越界：${r.cover}`);
  assert.ok(r.dead >= 0 && r.dead <= 4, `seed ${r.seed} 亡国数异常`);
  assert.ok(r.units >= 0 && r.kills >= 0 && r.harvest >= 0, `seed ${r.seed} 统计出现负值`);
  assert.ok(r.springRate >= 0 && r.springRate <= 1, `seed ${r.seed} 泉水覆盖率越界`);
}
const replay = playOne(1000, cfg);
for (const k of ['winner', 'winType', 'turns', 'cover', 'kills', 'harvest', 'spread']) {
  assert.equal(replay[k], rows[0][k], `同 seed 复跑的 ${k} 不一致，回合结算不再可复现`);
}
console.log(`\n健全性断言 ${rows.length} 局通过，同 seed 复现一致`);
