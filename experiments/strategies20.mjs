// experiments/strategies20.mjs — 20 个互不相同的实验策略（独立文件，不改项目现有代码）
//
// 契约与 server/bots.js 的 STRATEGIES 完全一致：
//   buildActions(view, game, ai) -> [{type:'produce'} | {unit,type:'move',path:[[x,y],...]} |
//                                   {unit,type:'attack',target} | {unit,type:'harvest'} |
//                                   {unit,type:'defend'} | {unit,type:'wait'}]
// 只 import server/engine.js 的公开纯函数；动作合法性的最终解释权在 engine.resolveTurn。
//
// 设计原则：20 个策略共用同一套寻路 / 采矿 / 攻击工具，差异只体现在
// 「目标选择、路径形状、开战时机、风险偏好」上 —— 这样比较的是策略思路，不是寻路实现。

import {
  AI_IDS, MAP_W, MAP_H, RULES,
  inBounds, chebyshev, unitAt, resourceAt, territoryAt,
  factionAlive,
} from '../server/engine.js';

const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const D = (u) => ({ unit: u.id, type: 'defend' });

/* ---------------- 共享工具 ---------------- */

/** 8 向贪心走位：每步一格、避开其它单位，返回可直接交给裁判的 path */
function stepToward(u, target, game, steps) {
  if (!target) return [];
  const path = [];
  let cur = { x: u.x, y: u.y };
  for (let i = 0; i < steps; i++) {
    const d0 = chebyshev(cur, target);
    if (d0 === 0) break;
    let best = null, bd = d0;
    for (const [dx, dy] of DIRS8) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!inBounds(nx, ny)) continue;
      const blocker = unitAt(game, nx, ny);
      if (blocker && blocker.id !== u.id) continue;
      const d = chebyshev({ x: nx, y: ny }, target);
      if (d < bd) { bd = d; best = [nx, ny]; }
    }
    if (!best) break;
    path.push(best);
    cur = { x: best[0], y: best[1] };
  }
  return path;
}

function nearest(from, list) {
  let target = null, distance = Infinity;
  for (const t of list) {
    if (!t) continue;
    const d = chebyshev(from, t);
    if (d < distance) { distance = d; target = t; }
  }
  return { target, distance };
}

function contextOf(view, game, ai) {
  const standings = Array.isArray(view.territoryStandings) ? view.territoryStandings : [];
  return {
    view, game, ai,
    home: game.bases[ai],
    enemies: game.units.filter(u => u.alive && u.owner !== ai),
    mines: game.resources.filter(r => r.type === 'mine' && r.stock > 0),
    springs: game.resources.filter(r => r.type === 'spring'),
    forts: game.resources.filter(r => r.type === 'fortress' && !r.claimedBy),
    enemyBases: AI_IDS.filter(a => a !== ai && factionAlive(game, a)).map(a => game.bases[a]),
    standings,
    rank: Math.max(0, standings.findIndex(s => s.ai === ai)),
    turn: game.turn,
    maxTurns: game.maxTurns,
    mr: view.moveRange,
    n: Math.max(1, view.units.length),
    no: u => Number(u.id.slice(1)) || 1,
  };
}

const mv = (u, target, ctx, steps = ctx.mr) => {
  const path = stepToward(u, target, ctx.game, steps);
  return path.length ? { unit: u.id, type: 'move', path } : null;
};

const guard = (u, ctx) =>
  (chebyshev(u, ctx.home) <= 1 ? D(u) : (mv(u, ctx.home, ctx) || D(u)));

const home = (u, ctx) => mv(u, ctx.home, ctx) || D(u);

const lowHp = (u, ratio = 0.45) => u.hp <= Math.max(2, u.maxHp * ratio);

function adjacentEnemy(u, ctx, pred = null) {
  return ctx.enemies.find(e => chebyshev(e, u) === 1 && (!pred || pred(e, u))) || null;
}

const strike = (u, e) => ({ unit: u.id, type: 'attack', target: e.id });

function harvest(u, ctx, radius = 6) {
  const here = resourceAt(ctx.game, u.x, u.y);
  if (here && here.type === 'mine' && here.stock > 0) return { unit: u.id, type: 'harvest' };
  const n = nearest(u, ctx.mines);
  return (n.target && n.distance <= radius) ? mv(u, n.target, ctx) : null;
}

function spring(u, ctx, radius = 6) {
  if (u.spring > 0) return null;
  const n = nearest(u, ctx.springs);
  return (n.target && n.distance <= radius) ? mv(u, n.target, ctx) : null;
}

/** 方框周长上的一点：半径随时间扩张，单位按 slot 分散到周长不同位置 */
function ringPoint(center, radius, slot, n, turn, speed = 1) {
  const half = Math.max(1, Math.round(radius));
  const side = 2 * half, perim = 8 * half;
  let s = (slot / Math.max(1, n)) * perim + turn * speed;
  s = ((s % perim) + perim) % perim;
  let tx, ty;
  if (s < side) { tx = center.x - half + s; ty = center.y - half; }
  else if (s < side * 2) { tx = center.x + half; ty = center.y - half + (s - side); }
  else if (s < side * 3) { tx = center.x + half - (s - side * 2); ty = center.y + half; }
  else { tx = center.x - half; ty = center.y + half - (s - side * 3); }
  return { x: clamp(Math.round(tx), 1, MAP_W), y: clamp(Math.round(ty), 1, MAP_H) };
}

/** 径向扇区：每个单位占一个角度，半径周期性内外往复 */
function radialPoint(u, ctx, span = 22, speed = 0.35) {
  const no = ctx.no(u);
  const ang = ((no - 1) % 8) / 8 * Math.PI * 2;
  const r = 3 + ((ctx.turn * speed + no * 1.7) % span);
  return {
    x: clamp(Math.round(ctx.home.x + Math.cos(ang) * r), 1, MAP_W),
    y: clamp(Math.round(ctx.home.y + Math.sin(ang) * r), 1, MAP_H),
  };
}

/** 在附近找「中立 / 敌方 / 非己方」领土格，用于走过即翻旗 */
function findLand(u, ctx, wanted = 'any', radius = 10, step = 2) {
  let best = null, bd = Infinity;
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const x = u.x + dx, y = u.y + dy;
      if (!inBounds(x, y)) continue;
      const o = territoryAt(ctx.game, x, y);
      const ok = wanted === 'enemy' ? (o && o !== ctx.ai)
        : wanted === 'neutral' ? (o === null)
          : (o !== ctx.ai);
      if (!ok) continue;
      const d = chebyshev(u, { x, y });
      if (d < bd) { bd = d; best = { x, y }; }
    }
  }
  return best;
}

const ringMove = (u, ctx, radius, speed = 1) =>
  mv(u, ringPoint(ctx.home, radius, ctx.no(u) - 1, ctx.n, ctx.turn, speed), ctx) || D(u);

const weakestEnemy = (ctx) => {
  const list = ctx.standings.filter(s => s.ai !== ctx.ai && s.alive);
  return list.length ? list[list.length - 1].ai : null;
};

const baseOf = (ctx, ai) => ctx.enemyBases.find(b => b.owner === ai) || null;

/** 诊断计数：任何策略内部异常都不该被静默吞掉，批量脚本会检查它是否为 0 */
export const DIAG = { errors: 0 };

/** 统一驱动：逐单位决策 → 兜底 defend → 可选造兵 */
function drive(view, game, ai, decide, { produce = true } = {}) {
  const ctx = contextOf(view, game, ai);
  const out = [];
  for (const u of view.units) {
    let a = null;
    try { a = decide(u, ctx); } catch { DIAG.errors++; a = null; }
    out.push(a && a.unit === u.id ? a : D(u));
  }
  if (produce && view.canProduce) out.push({ type: 'produce' });
  return out;
}

/** 策略描述 + 实现 */
const S = (key, name, family, idea, tactic, risk, decide, opts) => ({
  key, name, family, idea, tactic, risk,
  buildActions: (view, game, ai) => drive(view, game, ai, decide, opts),
});

/* ---------------- 20 个策略 ---------------- */

export const STRATEGIES20 = [

  S('swarm', '蜂群扩散', '扩张',
    '不设主目标，全员按固定扇区径向散开，用最多条移动轨迹把中立地刷成己方色。',
    '每个单位占一个 8 向角度，半径随回合在 3–25 格间周期往返；不采矿、不主动接战，只靠走过翻旗；目标被挡就换相位再试。',
    '没有守军，敌方穿插进来时大片相连领土可能被包围判定整块夺走；也不造兵补充。',
    (u, ctx) => {
      let m = mv(u, radialPoint(u, ctx), ctx);
      if (!m) m = mv(u, radialPoint(u, { ...ctx, turn: ctx.turn + 7 }), ctx);
      return m || ringMove(u, ctx, 6);
    }),

  S('ring', '环形开垦', '扩张',
    '经典基线：以基地为圆心画方框，单位沿周长分头推进，半径随回合稳步外扩。',
    '半径从 4 线性增长到 24，单位按编号均匀分布在方框周长上，行进本身即刷领土；顺路采矿。',
    '轨迹固定，容易被针对；后期半径饱和后增量变小。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e && u.hp >= e.hp) return strike(u, e);
      if (lowHp(u)) return home(u, ctx);
      if (ctx.view.stock < ctx.view.unitCost) {
        const h = harvest(u, ctx, 5);
        if (h) return h;
      }
      return ringMove(u, ctx, Math.min(24, 4 + ctx.turn * 0.22));
    }),

  S('mine', '矿脉优先', '经济',
    '资源是唯一造兵来源，因此把所有兵力先压到矿点上，攒够钱再谈扩张。',
    '站矿就采、附近矿就奔，矿采空或太远时才转入小半径环垦；每回合只要能造就造。',
    '前期领土增长慢，若被快攻型邻居压制可能来不及把经济优势兑现。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx, e => u.hp >= e.hp);
      if (e) return strike(u, e);
      const h = harvest(u, ctx, 12);
      if (h) return h;
      return ringMove(u, ctx, Math.min(12, 4 + ctx.turn * 0.10));
    }),

  S('spring', '泉水猎手', '军事',
    '把「踩泉水 +3 攻击、持续 4 回合」当成核心资源，反复续杯后主动找人换血。',
    '没加成且附近有泉就绕过去；有加成则直扑最近敌方单位，贴身即攻击；空窗期小半径环垦。',
    '追着泉水跑会偏离最优开垦路线，遇到避战型对手时攻击加成无处兑现。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const s = spring(u, ctx, 9);
      if (s) return s;
      const n = nearest(u, ctx.enemies);
      if (n.target && n.distance <= 14 && u.spring > 0) return mv(u, n.target, ctx) || D(u);
      return ringMove(u, ctx, Math.min(16, 4 + ctx.turn * 0.14));
    }),

  S('fort', '要塞抢占', '扩张',
    '要塞被占后每 4 回合自动向周边扩张一次，等于免费的外挂开垦器。',
    '开局 30 回合全员奔未被占领的要塞插旗；之后转中半径环垦，顺路采矿。',
    '要塞位置随机，抢不到就等于白白浪费开局；扩张只吃中立格，后期收益递减。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      if (ctx.turn < 30) {
        const n = nearest(u, ctx.forts);
        if (n.target) return mv(u, n.target, ctx) || D(u);
      }
      const h = harvest(u, ctx, 4);
      if (h) return h;
      return ringMove(u, ctx, Math.min(20, 4 + ctx.turn * 0.18));
    }),

  S('decap', '斩首突击', '军事',
    '不走发育路线：全军从第一回合就冲最近的敌方基地，站上去削耐久求征服胜。',
    '沿途遇敌先打，抵达基地格后 defend 持续围攻；低血不回头，靠人数堆伤害。',
    '老家完全放空，走过即翻旗规则下会被对手一路涂光；远征途中血量与距离衰减双重掉血。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const n = nearest(u, ctx.enemyBases);
      if (!n.target) return ringMove(u, ctx, 12);
      if (u.x === n.target.x && u.y === n.target.y) return D(u);
      return mv(u, n.target, ctx) || D(u);
    }),

  S('guard', '守门铁壁', '防守',
    '极端保守：全员钉在基地 3×3 内防御，只打贴脸敌人，赌近基地高血量上限与回血。',
    '不主动扩张、不采矿、不追击；所有单位 defend 减伤，靠脚下 3×3 每回合自动开垦保底。',
    '领土天花板极低，几乎不可能靠领土取胜；纯防守策略用来给其它策略做对照基线。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      return guard(u, ctx);
    }),

  S('border', '边境蚕食', '扩张',
    '专挑敌方已占领的格子走过去翻旗，把对手的地直接改色，而不是去开中立荒地。',
    '每回合扫描身边 10 格找最近的敌方领土格；找不到才退而求其次找非己方格，再没有才环垦。',
    '容易一头扎进敌方腹地被围死；不主动采矿，兵力耗完就断档。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e && u.hp >= e.hp) return strike(u, e);
      const t = findLand(u, ctx, 'enemy', 10, 2) || findLand(u, ctx, 'any', 7, 2);
      if (t) return mv(u, t, ctx) || D(u);
      return ringMove(u, ctx, Math.min(16, 5 + ctx.turn * 0.12));
    }),

  S('guerrilla', '游击穿插', '混合',
    '分兵：三分之一单位深入敌后蛇形穿插制造孤岛，其余留在本土稳住基本盘。',
    '编号满足 no%3===1 的单位专找敌方领土纵深穿插并顺路喝泉水；其余单位近家环垦 + 回防。',
    '深入单位远离基地后血量上限骤降，容易被逐个击破；分兵也削弱正面战斗力。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      if (ctx.no(u) % 3 === 1 && ctx.turn > 8) {
        const t = findLand(u, ctx, 'enemy', 14, 3);
        if (t) return mv(u, t, ctx) || D(u);
        const s = spring(u, ctx, 5);
        if (s) return s;
      }
      if (lowHp(u, 0.4)) return home(u, ctx);
      return ringMove(u, ctx, Math.min(14, 4 + ctx.turn * 0.12));
    }),

  S('economy', '经济转军事', '时机',
    '前 60% 回合只发育，钱粮与兵力攒够后集中转向最弱一家的基地，打时间差。',
    '前期采矿 + 半径 10 以内环垦；后期全军奔领土最少敌人的基地，遇敌且血量占优才交战。',
    '转型时机固定，若前期就被打残或对手在 60% 前已拉开领土差距，后期翻盘窗口很窄。',
    (u, ctx) => {
      const boom = ctx.turn > ctx.maxTurns * 0.6;
      const e = adjacentEnemy(u, ctx, e => u.hp >= e.hp);
      if (e) return strike(u, e);
      if (boom) {
        const w = weakestEnemy(ctx), b = w ? baseOf(ctx, w) : null;
        if (b) return mv(u, b, ctx) || D(u);
      }
      const h = harvest(u, ctx, 8);
      if (h) return h;
      return ringMove(u, ctx, Math.min(boom ? 18 : 10, 4 + ctx.turn * 0.12));
    }),

  S('center', '中心争夺', '扩张',
    '放弃家门口，把兵力全部投到棋盘正中，抢占四家交汇的中央要道。',
    '所有单位围绕 (25,25) 分成不同扇区落位，圈半径随时间缓慢外扩；挤住走不动时就近小圈开垦。',
    '远征路上血量上限被距离压制，且中央是四家火力交汇点，容易被夹击；兵力汇聚也容易互相挡路。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx, e => u.hp >= e.hp);
      if (e) return strike(u, e);
      const ang = (ctx.no(u) - 1) / Math.max(1, ctx.n) * Math.PI * 2;
      const r = Math.min(14, 3 + ctx.turn * 0.10);
      const t = { x: clamp(Math.round(25.5 + Math.cos(ang) * r), 1, MAP_W), y: clamp(Math.round(25.5 + Math.sin(ang) * r), 1, MAP_H) };
      return mv(u, t, ctx) || ringMove(u, ctx, 10);
    }),

  S('row', '扫帚横扫', '扩张',
    '把地图当田地，按水平行来回扫，一条条把整行刷成己方色。',
    '每个单位分配一条固定行（按编号错开），x 在 1–50 间按回合往复；行号每 12 回合下移一格。',
    '条带之间的空隙容易被包围填补规则反吃；目标点固定，机动性差。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const no = ctx.no(u);
      const y = clamp(ctx.home.y + (no - 1) * 3 - 6 + (Math.floor(ctx.turn / 12) % 3) * 2, 1, MAP_H);
      const phase = (ctx.turn * 1.6 + no * 7) % 98;
      const x = clamp(Math.round(phase < 49 ? 1 + phase : 1 + (98 - phase)), 1, MAP_W);
      return mv(u, { x, y }, ctx) || D(u);
    }),

  S('column', '纵向推进', '扩张',
    '与横扫正交的对照策略：按竖直列来回推，检验地图纵横方向是否存在系统性偏差。',
    '每个单位分配一条固定列，y 在 1–50 间往复；列号每 12 回合平移一格。',
    '和横扫同构，同样存在条带空隙与低机动性问题；用于对照而非追求强度。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const no = ctx.no(u);
      const x = clamp(ctx.home.x + (no - 1) * 3 - 6 + (Math.floor(ctx.turn / 12) % 3) * 2, 1, MAP_W);
      const phase = (ctx.turn * 1.6 + no * 7) % 98;
      const y = clamp(Math.round(phase < 49 ? 1 + phase : 1 + (98 - phase)), 1, MAP_H);
      return mv(u, { x, y }, ctx) || D(u);
    }),

  S('diag', '对角穿越', '扩张',
    '沿主对角线长距离往复，用单回合最长位移换取每回合最大翻旗面积。',
    '目标沿 (1,1)↔(50,50) 来回，单位按编号错开相位与横向偏移，尽量不重叠。',
    '长距离行军使血量上限长期被压低；对角线只覆盖窄带，角落领土靠不住。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const t = (ctx.turn * 1.4 + ctx.no(u) * 6) % 98;
      const k = clamp(Math.round(t < 49 ? 1 + t : 1 + (98 - t)), 1, MAP_W);
      const off = (ctx.no(u) % 3) - 1;
      return mv(u, { x: clamp(k + off, 1, MAP_W), y: k }, ctx) || D(u);
    }),

  S('weak', '追猎弱者', '军事',
    '欺软怕硬：每回合重新读取领土榜，全军扑向当前最弱一家的基地。',
    '锁定领土最少且仍存活的对手，直奔其基地；目标切换频繁，谁掉队就打谁。',
    '目标反复横跳会让兵力在路上空耗；同时放弃自家防务，容易被第三方偷家。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const w = weakestEnemy(ctx), b = w ? baseOf(ctx, w) : null;
      if (b) return mv(u, b, ctx) || D(u);
      return ringMove(u, ctx, 12);
    }),

  S('pacifist', '避战发育', '防守',
    '绝不主动攻击：只要敌人靠近就朝反方向绕开，把全部行动预算花在开垦与采矿上。',
    '相邻或 2 格内有敌就朝反方向走；否则先采矿、再中半径环垦；任何情况下不输出 attack。',
    '面对贴身肉搏型对手只能被动挨打；防御姿态牺牲了争夺关键格的机会。',
    (u, ctx) => {
      const n = nearest(u, ctx.enemies);
      if (n.target && n.distance <= 2) {
        const t = { x: clamp(2 * u.x - n.target.x, 1, MAP_W), y: clamp(2 * u.y - n.target.y, 1, MAP_H) };
        return mv(u, t, ctx) || D(u);
      }
      const h = harvest(u, ctx, 5);
      if (h) return h;
      return ringMove(u, ctx, Math.min(20, 4 + ctx.turn * 0.18));
    }),

  S('brawler', '贴身肉搏', '军事',
    '把击杀当成主要目标：永远朝最近敌人冲，贴脸就打，低血也不撤退。',
    '优先攻击相邻敌人；否则朝最近的敌方单位直线推进；没有可见敌人时才做小半径环垦。',
    '主动换血会持续减员，且远离基地时血量上限很低；击杀多不等于领土多。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx);
      if (e) return strike(u, e);
      const n = nearest(u, ctx.enemies);
      if (n.target) return mv(u, n.target, ctx) || D(u);
      return ringMove(u, ctx, Math.min(12, 4 + ctx.turn * 0.10));
    }),

  S('survivor', '低血回防', '防守',
    '把存活率放在第一位：血量低于 70% 立刻回基地补血，只有满状态单位才外出开垦。',
    '严格血量阈值管理；健康单位只在半径 10 内近家环垦，血量占优才接战，顺路采矿。',
    '过度保守导致领土增长慢；单位频繁往返基地，行动预算浪费在回头路上。',
    (u, ctx) => {
      if (lowHp(u, 0.7) && u.distToBase > 2) return home(u, ctx);
      const e = adjacentEnemy(u, ctx, e => u.hp >= e.hp);
      if (e) return strike(u, e);
      const h = harvest(u, ctx, 4);
      if (h) return h;
      return ringMove(u, ctx, Math.min(10, 4 + ctx.turn * 0.08));
    }),

  S('late', '末段冲刺', '时机',
    '前 70% 回合按兵不动守家，最后 30% 全员四散狂奔，赌终局按领土数结算。',
    '前段 defend 攒血与资源；冲刺阶段用径向扇区 + 敌方领土目标高速翻旗，把最后一回合的版面刷满。',
    '前段几乎不占地，若被早期征服或差距过大，末段 36 回合未必追得回来。',
    (u, ctx) => {
      const dash = ctx.turn > ctx.maxTurns * 0.7;
      if (!dash) {
        const e = adjacentEnemy(u, ctx);
        return e ? strike(u, e) : guard(u, ctx);
      }
      const t = findLand(u, ctx, 'enemy', 8, 2);
      if (t && ctx.no(u) % 2 === 0) return mv(u, t, ctx) || D(u);
      return mv(u, radialPoint(u, ctx, 20, 0.8), ctx) || D(u);
    }),

  S('pendulum', '自适应钟摆', '混合',
    '每 12 回合按当前领土排名换打法：领先就守成，中游稳开垦，垫底就孤注一掷偷家。',
    '领先 → 半径 8 近家环垦；垫底 → 奔最弱对手基地 / 翻敌方领土；其余 → 半径 16 常规环垦。',
    '状态切换有滞后，排名在临界点来回抖动时会反复改变全军目标，浪费行军回合。',
    (u, ctx) => {
      const e = adjacentEnemy(u, ctx, e => u.hp >= e.hp);
      if (e) return strike(u, e);
      const phase = Math.floor(ctx.turn / 12);
      if (ctx.rank === 0 || (phase % 3 === 0 && ctx.rank === 1)) {
        if (lowHp(u)) return home(u, ctx);
        return ringMove(u, ctx, 8);
      }
      if (ctx.rank >= 2 || phase % 3 === 2) {
        const t = findLand(u, ctx, 'enemy', 10, 3);
        if (t && ctx.no(u) % 2 === 0) return mv(u, t, ctx) || D(u);
        const w = weakestEnemy(ctx), b = w ? baseOf(ctx, w) : null;
        if (b) return mv(u, b, ctx) || D(u);
      }
      return ringMove(u, ctx, 16);
    }),
];

export const BY_KEY = Object.fromEntries(STRATEGIES20.map(s => [s.key, s]));
export const STRATEGY_KEYS = STRATEGIES20.map(s => s.key);
