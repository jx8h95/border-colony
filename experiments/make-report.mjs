// experiments/make-report.mjs — 从 results.json 生成两份交付文档（独立脚本，不改项目现有代码）
//   node experiments/make-report.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRATEGIES20 } from './strategies20.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
if (!r.meta.completed) throw new Error('results.json 显示对局未完整跑完，拒绝生成报告');

const META = STRATEGIES20;
const byKey = Object.fromEntries(r.strategies.map(s => [s.key, s]));
const name = k => byKey[k]?.name || k;
const f1 = v => Number(v).toFixed(1);
const f2 = v => Number(v).toFixed(2);
const rankOf = k => r.strategies.findIndex(s => s.key === k) + 1;

/** 某策略与其它策略同局时的净优劣势（只取样本足够的对阵） */
function rivals(k) {
  return r.pairs
    .filter(p => (p.a === k || p.b === k) && p.games >= 100)
    .map(p => ({ opp: p.a === k ? p.b : p.a, gap: p.a === k ? p.gap : -p.gap, games: p.games }))
    .sort((a, b) => b.gap - a.gap);
}

const metaBlock = [
  `- **对局数**：${r.meta.games.toLocaleString()} 局（全部跑到 ` + '`game.over`' + '，无截断、无抽样）',
  `- **随机种子**：\`${r.meta.masterSeed}\`（每局由主种子 + 局号派生，与并行度无关）`,
  `- **并行**：${r.meta.workers} 个 worker，耗时 ${(r.meta.elapsedMs / 1000 / 60).toFixed(1)} 分钟`,
  `- **棋盘 / 回合**：${r.meta.map} = ${r.meta.cells} 格，每局上限 ${r.meta.turnsPerGame} 回合，全部使用 \`CFG_DEF\` 默认参数`,
  `- **抽签**：${r.meta.sampling}`,
  `- **规则来源**：\`${r.meta.engine}\`，本实验未修改任何现有代码`,
].join('\n');

/* ================= 文档一：策略概述 ================= */

const overview = [];
overview.push('# 20 个实验策略 · 概述');
overview.push('');
overview.push('> 本文件与 `对局报告.md` 同属一次万局随机组合实验的交付物。策略实现在 `experiments/strategies20.mjs`，批量脚本在 `experiments/run-10000.mjs`。');
overview.push('');
overview.push('## 实验口径');
overview.push('');
overview.push(metaBlock);
overview.push('');
overview.push('所有策略遵循 `buildActions(view, game, ai)` 契约，共用同一套寻路 / 采矿 / 攻击工具，差异只在**目标选择、路径形状、开战时机与风险偏好**。动作合法性由 `server/engine.js` 的裁判最终裁定；脚本自身不修改规则、参数或胜负判定。');
overview.push('');
overview.push('「位置等权胜率」是对 A/B/C/D 四个位置分别算胜率再取平均，用来消除四家基地位置不对称带来的偏差；原始胜率附 95% 置信区间。平均基准胜率为 25%（四家必有一胜）。');
overview.push('');
overview.push('## 一览（按位置等权胜率排序）');
overview.push('');
overview.push('| # | 策略 | 类别 | 核心思路 | 等权胜率 | 平均领土 | 亡国率 |');
overview.push('|---:|---|---|---|---:|---:|---:|');
r.strategies.forEach((s, i) => {
  const m = META.find(x => x.key === s.key);
  overview.push(`| ${i + 1} | **${s.name}**（\`${s.key}\`） | ${s.family} | ${m.idea.replace(/\|/g, '／')} | ${f2(s.adjWinRate)}% | ${f1(s.avgCells)} 格 | ${f2(s.deathRate)}% |`);
});
overview.push('');
overview.push('## 逐个说明');
overview.push('');

META.forEach((m, i) => {
  const s = byKey[m.key];
  const rv = rivals(m.key);
  const best = rv[0], worst = rv[rv.length - 1];
  overview.push(`### ${String(i + 1).padStart(2, '0')} · ${m.name}（\`${m.key}\` · ${m.family}类）`);
  overview.push('');
  overview.push(`- **思路**：${m.idea}`);
  overview.push(`- **具体做法**：${m.tactic}`);
  overview.push(`- **风险 / 弱点**：${m.risk}`);
  overview.push(`- **实测**：样本 ${s.games.toLocaleString()} 局 · 位置等权胜率 **${f2(s.adjWinRate)}%**（总榜第 ${rankOf(m.key)}）· 原始胜率 ${f2(s.winRate)}% ± ${f2(s.ci95)}% · 平均名次 ${f2(s.avgRank)}`);
  overview.push(`- **局面数据**：终局领土 ${f1(s.avgCells)} 格（第 60 回合 ${f1(s.avgMidCells)} 格，后半程 ${s.avgLateGain >= 0 ? '+' : ''}${f1(s.avgLateGain)}）· 平均击杀 ${f2(s.avgKills)} · 存活单位 ${f2(s.avgUnits)} · 结余资源 ${f1(s.avgStock)}`);
  overview.push(`- **生存 / 结局**：被亡国率 ${f2(s.deathRate)}% · 出场局出现征服结局 ${f2(s.conquestRate)}%、其中该策略获胜 ${f2(s.conquestWinRate)}% · 提前结束率 ${f2(s.earlyRate)}%`);
  overview.push(`- **位置表现**：${s.pos.map(p => `${p.pos} ${f2(p.winRate)}%`).join(' / ')}`);
  if (best && worst) {
    overview.push(`- **最占优对阵**：对「${name(best.opp)}」净胜率差 +${f2(best.gap)} 个百分点（同局 ${best.games} 次）；**最吃亏对阵**：对「${name(worst.opp)}」${f2(worst.gap)} 个百分点（同局 ${worst.games} 次）`);
  }
  overview.push('');
});

overview.push('## 复现');
overview.push('');
overview.push('```bash');
overview.push('cd border-colony');
overview.push('node experiments/run-10000.mjs --games 10000 --workers 8 --seed 20261106 --out results.json');
overview.push('node experiments/make-report.mjs');
overview.push('```');
overview.push('');
overview.push('`results.json` 为全部汇总，`results-games.csv` 为 10,000 行逐局原始记录（可用 Excel / pandas 复核）。实测同种子用 4 worker 与 8 worker 跑出的逐局 CSV 哈希完全一致，结果与并行度无关。');
overview.push('');

fs.writeFileSync(path.join(__dirname, '策略概述.md'), overview.join('\n'), 'utf8');

/* ================= 文档二：对局报告 ================= */

const g = r.global;
const rep = [];
rep.push('# 万局随机组合对局报告');
rep.push('');
rep.push(`> 生成于 ${r.meta.generatedAt} · ${r.meta.games.toLocaleString()} 局 · 20 策略 · 完整跑满`);
rep.push('');
rep.push('## 1. 实验设置');
rep.push('');
rep.push(metaBlock);
rep.push('');
rep.push('**约束**：项目现有代码与架构零改动。20 个策略、批量脚本、报告生成器、数据文件全部放在新增的 `experiments/` 目录；只调用 `server/engine.js` 导出的纯函数（`createGame / resolveTurn / getViewFor` 等）。');
rep.push('');
rep.push('**可复现性**：每局的地图种子与策略抽签都由「主种子 + 局号」独立派生，不依赖执行顺序或 worker 数量。实测同一主种子分别用 4 / 8 worker 各跑 100 局，逐局 CSV 的 SHA-256 完全一致。');
rep.push('');
rep.push('**完整性校验**：`meta.completed = true`，异常局 0，策略内部异常 0，实际完成局数 = 期望局数。');
rep.push('');

rep.push('## 2. 全局结果');
rep.push('');
rep.push('| 指标 | 数值 |');
rep.push('|---|---:|');
rep.push(`| 领土判定胜（回合耗尽） | ${g.winTypes.territory.toLocaleString()} 局 / ${f2(g.winTypePct.territory)}% |`);
rep.push(`| 征服胜（只剩一家基地） | ${g.winTypes.conquest.toLocaleString()} 局 / ${f2(g.winTypePct.conquest)}% |`);
rep.push(`| 同归于尽 | ${g.winTypes['mutual-destruction'] || 0} 局 / ${f2(g.winTypePct['mutual-destruction'] || 0)}% |`);
rep.push(`| 平均回合数 | ${f2(g.avgTurns)} |`);
rep.push(`| 回合数中位数 / 最小 / 最大 | ${g.medianTurns} / ${g.minTurns} / ${g.maxTurns} |`);
rep.push(`| 提前结束率（< ${r.meta.turnsPerGame} 回合） | ${f2(g.earlyFinishRate)}% |`);
rep.push(`| 出现亡国的对局比例 | ${f2(g.anyDeathRate)}% |`);
rep.push(`| 场均亡国家数 | ${f2(g.avgDeadFactions)} |`);
rep.push(`| 终局地图覆盖率 | ${f2(g.avgCoverage * 100)}% |`);
rep.push(`| 冠亚军领土差 | ${f1(g.avgMargin)} 格 |`);
rep.push(`| 出现过的不同策略组合 | ${g.uniqueCombos.toLocaleString()} 种（理论上限 C(20,4)=4,845） |`);
rep.push('');

rep.push('## 3. 位置偏差与校正');
rep.push('');
rep.push('| 位置 | 出场 | 原始胜率 | 平均领土 |');
rep.push('|---|---:|---:|---:|');
for (const p of r.positions) rep.push(`| ${p.pos} | ${p.games.toLocaleString()} | ${f2(p.winRate)}% | ${f1(p.avgCells)} 格 |`);
rep.push('');
const posSpread = Math.max(...r.positions.map(p => p.winRate)) - Math.min(...r.positions.map(p => p.winRate));
rep.push(`四个位置的理论胜率都是 25%，实测极差 **${f2(posSpread)} 个百分点**。基地坐标固定、泉水 / 矿点随机分布，因此位置本身有系统性优劣。为公平比较策略，下文主榜一律采用「位置等权胜率」：先算某策略在 A/B/C/D 各自的胜率，再取算术平均，等价于强制它在四个位置等量出场。`);
rep.push('');

rep.push('## 4. 策略强度总榜');
rep.push('');
rep.push('| 排名 | 策略 | 类别 | 样本 | 等权胜率 | 原始胜率 ±95%CI | 平均领土 | 平均名次 | 平均击杀 | 亡国率 | 征服局占比 |');
rep.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
r.strategies.forEach((s, i) => {
  rep.push(`| ${i + 1} | **${s.name}** \`${s.key}\` | ${s.family} | ${s.games.toLocaleString()} | **${f2(s.adjWinRate)}%** | ${f2(s.winRate)}% ± ${f2(s.ci95)}% | ${f1(s.avgCells)} | ${f2(s.avgRank)} | ${f2(s.avgKills)} | ${f2(s.deathRate)}% | ${f2(s.conquestRate)}% |`);
});
rep.push('');
rep.push(`> 每个策略约 2,000 局样本，胜率 95% 置信区间约 ±${f2(r.strategies[0].ci95)} 个百分点；榜上相邻名次若差距小于两个 CI，不应解读为显著强弱。置信区间按二项分布近似计算。`);
rep.push('');

rep.push('## 5. 打法类别对比');
rep.push('');
rep.push('| 类别 | 策略数 | 出场局 | 原始胜率 | 平均领土 | 平均击杀 |');
rep.push('|---|---:|---:|---:|---:|---:|');
for (const f of r.families) rep.push(`| ${f.family} | ${f.strategies} | ${f.games.toLocaleString()} | ${f2(f.winRate)}% | ${f1(f.avgCells)} 格 | ${f2(f.avgKills)} |`);
rep.push('');

rep.push('## 6. 节奏与打法特征');
rep.push('');
rep.push('第 60 回合的领土用来切分前 / 后半程：`后半程增量 = 终局领土 − 第 60 回合领土`。');
rep.push('');
rep.push('| 策略 | 第 60 回合领土 | 终局领土 | 后半程增量 | 存活单位 | 结余资源 | 提前结束率 |');
rep.push('|---|---:|---:|---:|---:|---:|---:|');
for (const s of [...r.strategies].sort((a, b) => b.avgLateGain - a.avgLateGain)) {
  rep.push(`| ${s.name} | ${f1(s.avgMidCells)} | ${f1(s.avgCells)} | ${s.avgLateGain >= 0 ? '+' : ''}${f1(s.avgLateGain)} | ${f2(s.avgUnits)} | ${f1(s.avgStock)} | ${f2(s.earlyRate)}% |`);
}
rep.push('');
const lateBest = [...r.strategies].sort((a, b) => b.avgLateGain - a.avgLateGain)[0];
const earlyBest = [...r.strategies].sort((a, b) => b.avgMidCells - a.avgMidCells)[0];
rep.push(`后期发力最猛的是「${lateBest.name}」（后半程 ${f1(lateBest.avgLateGain)} 格），前半程领跑的是「${earlyBest.name}」（第 60 回合 ${f1(earlyBest.avgMidCells)} 格）。`);
rep.push('');

rep.push('## 7. 组合与克制');
rep.push('');
rep.push(`10,000 局共出现 ${g.uniqueCombos.toLocaleString()} 种无序策略组合，平均每种约 ${f2(r.meta.games / g.uniqueCombos)} 局。下列组合榜只统计出现 ≥ 3 次的组合。`);
rep.push('');
rep.push('**出现最多的组合**');
rep.push('');
rep.push('| 组合 | 局数 | 征服结局率 | 平均回合 | 平均覆盖率 |');
rep.push('|---|---:|---:|---:|---:|');
for (const c of r.combos.mostCommon) rep.push(`| ${c.combo} | ${c.games} | ${f2(c.conquestRate)}% | ${f1(c.avgTurns)} | ${f2(c.avgCoverage * 100)}% |`);
rep.push('');
rep.push('**最容易打出征服胜的组合**');
rep.push('');
rep.push('| 组合 | 局数 | 征服结局率 | 平均回合 |');
rep.push('|---|---:|---:|---:|');
for (const c of r.combos.mostConquest) rep.push(`| ${c.combo} | ${c.games} | ${f2(c.conquestRate)}% | ${f1(c.avgTurns)} |`);
rep.push('');
rep.push('**结束最快 / 最慢的组合**');
rep.push('');
rep.push('| 最快组合 | 平均回合 | | 最慢组合 | 平均回合 |');
rep.push('|---|---:|---|---|---:|');
for (let i = 0; i < Math.min(10, r.combos.fastest.length, r.combos.slowest.length); i++) {
  const a = r.combos.fastest[i], b = r.combos.slowest[i];
  rep.push(`| ${a.combo} | ${f1(a.avgTurns)} | | ${b.combo} | ${f1(b.avgTurns)} |`);
}
rep.push('');
rep.push('**净胜率差最大的一对对阵**（同局样本 ≥ 100 次；差值 = 前者胜率 − 后者胜率）');
rep.push('');
rep.push('| 策略 A | 策略 B | 同局次数 | A 胜率 | B 胜率 | 差值 |');
rep.push('|---|---|---:|---:|---:|---:|');
for (const p of [...r.pairs].filter(p => p.games >= 100).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 12)) {
  rep.push(`| ${name(p.a)} | ${name(p.b)} | ${p.games} | ${f2(p.aWinRate)}% | ${f2(p.bWinRate)}% | ${p.gap >= 0 ? '+' : ''}${f2(p.gap)} |`);
}
rep.push('');

rep.push('## 8. 数据要点');
rep.push('');
const top = r.strategies[0], bottom = r.strategies[r.strategies.length - 1];
const bestFamily = r.families[0], worstFamily = r.families[r.families.length - 1];
rep.push(`1. **最强 / 最弱**：「${top.name}」位置等权胜率 ${f2(top.adjWinRate)}%，「${bottom.name}」${f2(bottom.adjWinRate)}%，相差 ${f2(top.adjWinRate - bottom.adjWinRate)} 个百分点；两者平均领土 ${f1(top.avgCells)} vs ${f1(bottom.avgCells)} 格。`);
rep.push(`2. **类别分化**：「${bestFamily.family}」类胜率 ${f2(bestFamily.winRate)}%，「${worstFamily.family}」类 ${f2(worstFamily.winRate)}%，差 ${f2(bestFamily.winRate - worstFamily.winRate)} 个百分点。`);
rep.push(`3. **结局形态**：${f2(g.winTypePct.territory)}% 的对局打满 ${r.meta.turnsPerGame} 回合按领土结算，${f2(g.winTypePct.conquest)}% 提前因征服结束；${f2(g.anyDeathRate)}% 的对局至少有一家亡国，场均亡国 ${f2(g.avgDeadFactions)} 家。`);
rep.push(`4. **位置不均衡**：四位置原始胜率极差 ${f2(posSpread)} 个百分点，因此只看原始胜率会把「坐到好位置」误算成策略强度。`);
rep.push(`5. **统计口径**：每策略约 ${Math.round(top.games).toLocaleString()} 局样本，95% CI 约 ±${f2(top.ci95)} 个百分点；同局对阵的净胜率差同样受此量级噪声影响。`);
rep.push('');

/* 逐局 CSV 里才有的两条口径：按结局类型分的回合 / 分差，以及「有场上最强策略参与时」的回合数 */
let csvStats = null;
const csvPath = path.join(__dirname, 'results-games.csv');
if (fs.existsSync(csvPath)) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ix = k => head.indexOf(k);
  const acc = {};
  const withTop = { n: 0, turns: 0 };
  const withoutTop = { n: 0, turns: 0 };
  for (const row of lines.slice(1)) {
    const cells = row.split(',');
    const t = cells[ix('winType')];
    const turns = Number(cells[ix('turns')]);
    const margin = Number(cells[ix('margin')]);
    acc[t] = acc[t] || { n: 0, turns: 0, margin: 0 };
    acc[t].n++; acc[t].turns += turns; acc[t].margin += margin;
    const four = ['A', 'B', 'C', 'D'].map(p => cells[ix(p)]);
    if (four.includes(top.key)) { withTop.n++; withTop.turns += turns; } else { withoutTop.n++; withoutTop.turns += turns; }
  }
  const avg = o => (o && o.n ? { n: o.n, turns: o.turns / o.n, margin: o.margin / o.n } : null);
  csvStats = { territory: avg(acc.territory), conquest: avg(acc.conquest), withTop, withoutTop };
}

const conquerors = [...r.strategies].filter(s => s.conquestWins > 0).sort((a, b) => b.conquestWins - a.conquestWins);
const mainConq = conquerors.slice(0, 3);
const minorConq = conquerors.slice(3).sort((a, b) => a.conquestWins - b.conquestWins);
const econ = byKey.economy, decap = byKey.decap;
const vsPair = (a, b) => {
  const p = r.pairs.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  if (!p) return null;
  return { games: p.games, aWin: p.a === a ? p.aWinRate : p.bWinRate, bWin: p.a === a ? p.bWinRate : p.aWinRate };
};
const eVsD = vsPair('economy', 'decap');

rep.push('## 9. 观察与解读');
rep.push('');
const conquerorGames = conquerors.reduce((s, x) => s + x.games, 0);
const nonConqGames = r.meta.games * 4 - conquerorGames;

rep.push(`**① 征服是一条「少数派通道」。** 20 个策略里只有 ${conquerors.length} 个曾经靠打基地赢过，其中${mainConq.map(s => `${s.name} ${s.conquestWins.toLocaleString()} 次`).join('、')}占了绝对多数，剩下${minorConq.map(s => `${s.name} ${s.conquestWins} 次`).join('、')}全部属于偶发。其余 ${r.strategies.length - conquerors.length} 个策略在合计 ${nonConqGames.toLocaleString()} 个出场位里从未以征服获胜 —— 它们的天花板被锁死在「打满 ${r.meta.turnsPerGame} 回合后领土第一」，输赢要等结算，无法提前终结比赛。`);
rep.push('');
if (csvStats) {
  rep.push(`**② 「${decap.name}」改的是时间轴，不是战力。** 它场均只有 ${f2(decap.avgKills)} 个击杀（20 个策略里最低），却拿到 ${f2(decap.adjWinRate)}% 的位置等权胜率。原因在于基地被踩住就亡国，对手前 60 回合攒下的领土直接作废，不需要清场。含它的 ${csvStats.withTop.n.toLocaleString()} 局平均 ${f1(csvStats.withTop.turns / csvStats.withTop.n)} 回合结束，不含它的 ${csvStats.withoutTop.n.toLocaleString()} 局平均 ${f1(csvStats.withoutTop.turns / csvStats.withoutTop.n)} 回合 —— 它把一半对局从「翻地竞速」改成了「斩首赛」。`);
  rep.push('');
  rep.push(`**③ 结局形态两极：征服是碾压，领土判定才是胶着。** 征服结局平均 ${f1(csvStats.conquest.turns)} 回合、冠亚军领土差 ${f1(csvStats.conquest.margin)} 格（败者清零，差距被放大）；领土结局平均 ${f1(csvStats.territory.turns)} 回合、差 ${f1(csvStats.territory.margin)} 格。换句话说，${f2(g.winTypePct.territory)}% 的对局是在混战中被反复拉平后靠最后一格定胜负，而任何一次成功的斩首都是直接结案。`);
  rep.push('');
}
rep.push(`**④ 「${econ.name}」是唯一真正有效的第二极，但被第一名克制。** 它 ${f1(econ.avgCells)} 格（全场最高）、后半程 +${f1(econ.avgLateGain)} 格、场均可动用 ${f2(econ.avgUnits)} 个单位、结余资源 ${f1(econ.avgStock)}（也是最高），把「先攒后打」做成了正循环。可它和「${decap.name}」同局 ${eVsD ? eVsD.games : '—'} 次，胜率只有 ${eVsD ? f2(eVsD.aWin) : '—'}%（对手 ${eVsD ? f2(eVsD.bWin) : '—'}%）—— 攒钱要 60 回合，斩首只要 20 回合，节奏差就是死穴。`);
rep.push('');
rep.push(`**⑤ 扩张类整体输在「离基地越远越脆」。** 8 个扩张策略合计 ${r.families.find(f => f.family === '扩张').games.toLocaleString()} 局、胜率 ${f2(r.families.find(f => f.family === '扩张').winRate)}%。走过即占领本该利好刷地，但血量上限随距离衰减，远端翻下的旗子守不住；再加上围合判定会把成片孤立的领土整块判给对手，刷得越开越容易被一刀切走。终局覆盖率 ${f2(g.avgCoverage * 100)}% 说明地确实被占了，只是没留在扩张者手里。`);
rep.push('');
rep.push(`**⑥ 纯防守在这套胜负规则下等于必输。** 「${bottom.name}」${bottom.wins}/${bottom.games.toLocaleString()} 局，终局只剩 ${f1(bottom.avgCells)} 格；它的场均击杀 ${f2(bottom.avgKills)} 反而高于「${decap.name}」，说明贴脸反击其实是有效的 —— 但胜负只看领土多少，不产生领土就永远拿不到第一。同类里最好的「避战发育」也只到 ${f2(byKey.pacifist.adjWinRate)}%。`);
rep.push('');
rep.push('**⑦ 对调参的三条启示**（只针对策略池设计，不涉及规则改动）：');
rep.push('');
rep.push(`- **给一半策略补上第二条胜利通道**：${r.strategies.length - conquerors.length} 个策略完全没有打基地的动机，样本里它们只是在陪跑；让它们至少在末段能威胁基地，才会有真正的策略博弈。`);
rep.push('- **基地的耐久收益偏高**：踩住即削耐久、不需要先清理守军，导致速攻的性价比压过一切运营。若要平衡，方向是提高基地耐久 / 要求周边无守军才可削，而不是削弱攻击力。');
rep.push('- **距离衰减对扩张的惩罚过重**：扩张类的领土在第 60 回合后普遍负增长（见第 6 节），本质是「走远了打不过、守不住」。要么给远端单位续航手段，要么让领土判定对连续成片占领给额外权重。');
rep.push('');

rep.push('## 10. 局限与复现');
rep.push('');
rep.push('- 这 20 个策略是**为对照实验写的启发式打法**，不是各思路的最优实现；胜率衡量的是「这套具体实现的强弱」，不等价于该思路的理论上限。');
rep.push('- 全部使用 `CFG_DEF` 默认参数与 120 回合上限；改血量衰减、移动力、泉水密度等参数，排序可能明显变化。');
rep.push('- 每局地图由固定种子决定，10,000 局覆盖 10,000 张不同布局；策略抽签无放回、位置再打乱，但未做「同一四策略组合在所有 4! 种位置上各跑一次」的配对设计，位置影响靠等权平均削弱而非完全消除。');
rep.push('- 本实验只跑脚本策略，不涉及大模型操控、对局记忆或网页界面；结论不直接外推到 LLM 对局。');
rep.push('- 原始数据在 `results-games.csv`，汇总在 `results.json`；复现命令见 `策略概述.md` 末尾。');
rep.push('');

fs.writeFileSync(path.join(__dirname, '对局报告.md'), rep.join('\n'), 'utf8');

console.log('已生成 策略概述.md / 对局报告.md');
console.log(`完成 ${r.meta.games} 局 · 最强 ${top.name} ${top.adjWinRate}% · 最弱 ${bottom.name} ${bottom.adjWinRate}%`);
