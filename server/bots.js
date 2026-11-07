// server/bots.js — 四种脚本策略（规则文案已对齐现行版本）
// 目的：让四种打法分别把现行机制跑到极限，方便观察平衡性 ——
//   A 侵略者  远征斩首 + 抢泉水，专测「围攻 / 2 格自动交战 / 走过翻旗」
//   B 经济人  采矿滚雪球 + 大范围开垦，专测「资源→造兵」曲线
//   C 要塞家  抢要塞 + 沿中线扩张，专测「要塞扩张 / 包围易主」
//   D 龟缩者  贴家密垦 + 反击，专测「守军保土 / 集火防守」
// 四家永远敌对。策略全部确定性，同 seed 可复盘。
// 注意：style 文案会原样注入 LLM 提示词，规则改动时必须同步这里，否则模型会拿到作废规则。

import {
  AI_IDS, RULES, chebyshev, resourceAt, unitAt, inBounds, territoryAt, isWall,
  factionAlive, MAP_W, MAP_H,
} from './engine.js';

const fortress = {
  name: '要塞家',
  style: '抢要塞当扩张发动机，派专人插旗；其余兵力沿中线大范围穿插，专门走别人已占领的格子把地翻回来，并围出没有守军的孤岛。',
  buildActions(view, game, ai) { return diplomatActions(view, game, ai); },
};

export const STRATEGIES = {
  aggressive: {
    name: '侵略者',
    style: '开局就远征：全军（留一个守家）扑向最近的敌方基地，路上顺手抢泉水提升攻击；走过的格子连同周边 8 格全部翻旗，进入 2 格交战圈即自动开火，站上基地就拆耐久。',
    buildActions(view, game, ai) { return aggressiveActions(view, game, ai); },
  },
  economist: {
    name: '经济人',
    style: '资源优先：优先踩矿点采集，攒够就造兵；兵力成型后大范围开垦，血量低了回基地补给。尽量避免正面接战。',
    buildActions(view, game, ai) { return economistActions(view, game, ai); },
  },
  fortress,
  diplomat: fortress,   // 兼容旧配置：v6.1 取消结盟，「外交家」改名为「要塞家」
  turtle: {
    name: '龟缩者',
    style: '贴着自家基地小半径密垦，把家门口填成铁板：留兵守在领土里，靠 2 格自动交战与多人集火吃掉孤军来犯者，免得被包围判定整块夺走。',
    buildActions(view, game, ai) { return turtleActions(view, game, ai); },
  },
};

/* ---------------- 通用走位 ---------------- */

const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

const clampX = v => Math.max(1.5, Math.min(MAP_W - 0.5, v));
const clampY = v => Math.max(1.5, Math.min(MAP_H - 0.5, v));

function nearest(from, list) {
  let best = null, bestD = Infinity;
  if (!from) return { target: null, distance: bestD };
  for (const t of list) {
    if (!t) continue;
    const d = chebyshev(from, t);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { target: best, distance: bestD };
}

/** 8 向贪心走位，遇单位或障碍侧移绕行 */
function stepToward(unit, target, game, steps) {
  const path = [];
  let cur = { x: unit.x, y: unit.y };
  for (let i = 0; i < steps; i++) {
    const here = chebyshev(cur, target);
    if (here === 0) break;
    let best = null, bestD = here;
    for (const [dx, dy] of DIRS8) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!inBounds(nx, ny) || isWall(game, nx, ny)) continue;
      const blocker = unitAt(game, nx, ny);
      if (blocker && blocker.id !== unit.id) continue;
      const d = chebyshev({ x: nx, y: ny }, target);
      if (d < bestD) { bestD = d; best = [nx, ny]; }
    }
    if (!best) {
      // 侧移一格打破僵局（墙同样不能踩）
      for (const [dx, dy] of DIRS8) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (!inBounds(nx, ny) || isWall(game, nx, ny)) continue;
        const blocker = unitAt(game, nx, ny);
        if (blocker && blocker.id !== unit.id) continue;
        best = [nx, ny];
        break;
      }
      if (!best) break;
    }
    path.push(best);
    cur = { x: best[0], y: best[1] };
  }
  return path;
}

/** 方框巡逻：沿以 center 为中心的正方形周长前进，轨迹覆盖 3 格宽带 */
function ringPath(u, center, radius, turn, moveRange, slot, n, game) {
  const half = Math.max(1, Math.round(radius));
  const side = 2 * half;
  const perim = 8 * half;
  const stride = moveRange;
  let s = (slot / n) * perim + turn * stride;
  s = ((s % perim) + perim) % perim;

  let tx, ty;
  if (s < side) { tx = center.x - half + s; ty = center.y - half; }
  else if (s < side * 2) { tx = center.x + half; ty = center.y - half + (s - side); }
  else if (s < side * 3) { tx = center.x + half - (s - side * 2); ty = center.y + half; }
  else { tx = center.x - half; ty = center.y + half - (s - side * 3); }

  const goal = { x: clampX(tx), y: clampY(ty) };
  if (chebyshev(u, goal) < 0.5) return null;
  const path = stepToward(u, goal, game, moveRange);
  return path.length ? path : null;
}

function enemyList(game, ai) {
  return game.units.filter(x => x.alive && x.owner !== ai);
}

/** 站在矿上就采，附近有矿就过去 */
function tryHarvest(u, view, game, radius) {
  const here = resourceAt(game, u.x, u.y);
  if (here && here.type === 'mine' && here.stock > 0) return { unit: u.id, type: 'harvest' };

  const near = nearest(u, game.resources.filter(r => r.type === 'mine' && r.stock > 0));
  if (near.target && near.distance <= radius) {
    const path = stepToward(u, near.target, game, view.moveRange);
    if (path.length) return { unit: u.id, type: 'move', path };
  }
  return null;
}

/** 顺路喝泉水：距离 ≤ radius 就绕一点过去 */
function trySpring(u, view, game, radius) {
  if (u.spring > 0) return null;
  const near = nearest(u, game.resources.filter(r => r.type === 'spring'));
  if (!near.target || near.distance > radius) return null;
  const path = stepToward(u, near.target, game, view.moveRange);
  return path.length ? { unit: u.id, type: 'move', path } : null;
}

/** v6.1：找附近一块别人已占领的格子，走过去翻旗 */
function enemyLandTarget(game, ai, u, radius) {
  let best = null, bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      const x = u.x + dx, y = u.y + dy;
      if (!inBounds(x, y)) continue;
      const o = territoryAt(game, x, y);
      if (!o || o === ai) continue;
      const d = chebyshev(u, { x, y });
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

function maybeProduce(view, out) {
  if (view.canProduce) out.push({ type: 'produce' });
}

function lowHp(u) {
  return u.hp <= Math.max(2, Math.round(u.maxHp * 0.45));
}

function goHome(u, view, game, ai) {
  const b = game.bases[ai];
  if (!b || !b.alive) return null;
  const path = stepToward(u, b, game, view.moveRange);
  return path.length ? { unit: u.id, type: 'move', path } : null;
}

/** 守家：一号士兵钉在基地格上 */
function guardBase(u, view, game, ai) {
  const b = game.bases[ai];
  if (!b || !b.alive) return null;
  if (u.x === b.x && u.y === b.y) return { unit: u.id, type: 'defend' };
  const path = stepToward(u, b, game, view.moveRange);
  return path.length ? { unit: u.id, type: 'move', path } : { unit: u.id, type: 'defend' };
}

function isGuard(u) {
  return Number(u.id.slice(1)) === 1;
}

/* ---------------- A 侵略者 ---------------- */

function aggressiveActions(view, game, ai) {
  const out = [];
  const enemies = enemyList(game, ai);
  const enemyBases = (view.bases || []).filter(b => b.alive && b.owner !== ai && factionAlive(game, b.owner));
  const home = game.bases[ai];
  // 前 40% 回合先在外围抢地养兵，之后派「偶数编号」的兵力斩首，
  // 另一半继续大范围巡逻 —— v6.1 走过即翻旗，全员远征会把老家白送人。
  const march = game.turn > game.maxTurns * 0.4;

  for (const u of view.units) {
    if (isGuard(u)) { out.push(guardBase(u, view, game, ai)); continue; }

    // v6.1：走过敌方领土会翻旗，家里不留人会被人一路涂光。2、3 号固定本土巡逻。
    const no = Number(u.id.slice(1));
    if (no <= 3) {
      const patrol = ringPath(u, home, Math.min(8, 3 + game.turn * 0.05), game.turn, view.moveRange, no, 4, game);
      out.push(patrol ? { unit: u.id, type: 'move', path: patrol } : { unit: u.id, type: 'defend' });
      continue;
    }

    // 低血先回家补，否则远征军会自己烂掉
    if (lowHp(u) && u.distToBase > 3) {
      const h = goHome(u, view, game, ai);
      if (h) { out.push(h); continue; }
    }

    const adj = enemies.find(e => chebyshev(e, u) <= RULES.engageRange);
    if (adj) { out.push({ unit: u.id, type: 'attack', target: adj.id }); continue; }

    // 缺钱就顺路采矿（资源是造兵的唯一来源）
    if (view.stock < view.unitCost) {
      const use = tryHarvest(u, view, game, 4);
      if (use) { out.push(use); continue; }
    }

    const raider = march && no % 2 === 0;
    const base = raider ? nearest(u, enemyBases) : { target: null, distance: Infinity };

    // 已经站上敌方基地 → 拆耐久
    if (base.target && base.target.x === u.x && base.target.y === u.y) {
      out.push({ unit: u.id, type: 'defend' });
      continue;
    }

    // 泉水就在附近就绕一口，攻击 +3 很值
    const spring = trySpring(u, view, game, 4);
    if (spring) { out.push(spring); continue; }

    // 贴到基地外圈还站不上去（被守军挡着）→ 先清守军
    if (base.target && base.distance <= 2) {
      const block = nearest(u, enemies.filter(e => chebyshev(e, base.target) <= 2));
      if (block.target) {
        const path = stepToward(u, block.target, game, view.moveRange);
        if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
        out.push({ unit: u.id, type: 'defend' });
        continue;
      }
    }

    // 主目标：最近敌方基地
    if (base.target) {
      const path = stepToward(u, base.target, game, view.moveRange);
      if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
    }

    // 打不到基地就沿路开垦，别站着发呆
    const n = Math.max(4, view.unitsAlive - 1);
    const slot = (Number(u.id.slice(1)) - 2 + n) % n;
    const radius = Math.min(26, 4 + game.turn * 0.25);
    const path = ringPath(u, home, radius, game.turn, view.moveRange, slot, n, game);
    if (path) { out.push({ unit: u.id, type: 'move', path }); continue; }
    out.push({ unit: u.id, type: 'defend' });
  }

  maybeProduce(view, out);
  return out;
}

/* ---------------- B 经济人 ---------------- */

function economistActions(view, game, ai) {
  const out = [];
  const base = game.bases[ai];
  // 末期：钱粮够了就翻脸，派 3 个兵去偷最弱一家的基地（经济转军事）
  const ranked = [...AI_IDS].sort((a, b) => game.territoryCount[b] - game.territoryCount[a]);
  const behind = ranked.indexOf(ai) > 0;
  const weakest = ranked[ranked.length - 1];
  const raid = game.turn > game.maxTurns * 0.75 && behind && weakest !== ai && game.bases[weakest]?.alive
    ? game.bases[weakest] : null;

  for (const u of view.units) {
    if (isGuard(u)) { out.push(guardBase(u, view, game, ai)); continue; }

    if (lowHp(u)) { const h = goHome(u, view, game, ai); if (h) { out.push(h); continue; } }

    const foes = enemyList(game, ai);
    const adj = foes.find(e => chebyshev(e, u) <= RULES.engageRange && u.hp >= e.hp);
    if (adj) { out.push({ unit: u.id, type: 'attack', target: adj.id }); continue; }

    // 家门口有敌人就回防，别让人把基地偷了
    const threat = nearest(u, foes.filter(e => chebyshev(e, base) <= 8));
    if (threat.target && u.distToBase <= 12) {
      const path = stepToward(u, threat.target, game, view.moveRange);
      if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
    }

    if (raid && view.unitsAlive >= 8 && Number(u.id.slice(1)) > view.unitsAlive - 3) {
      const path = stepToward(u, raid, game, view.moveRange);
      if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
    }

    const got = tryHarvest(u, view, game, 7);
    if (got) { out.push(got); continue; }

    // 大范围开垦：框随时间扩张，单位沿周长分头推进
    const n = Math.max(4, view.unitsAlive - 1);
    const slot = (Number(u.id.slice(1)) - 2 + n) % n;
    const radius = Math.min(23, 4 + game.turn * 0.20);
    const path = ringPath(u, base, radius, game.turn, view.moveRange, slot, n, game);
    if (path) { out.push({ unit: u.id, type: 'move', path }); continue; }
    out.push({ unit: u.id, type: 'defend' });
  }

  maybeProduce(view, out);
  return out;
}

/* ---------------- C 要塞家 ---------------- */

function diplomatActions(view, game, ai) {
  const out = [];
  const base = game.bases[ai];
  const mine = game.resources.filter(r => r.type === 'fortress' && !r.claimedBy);
  const ownFort = game.resources.filter(r => r.type === 'fortress' && r.claimedBy === ai);
  const enemies = enemyList(game, ai);

  for (const u of view.units) {
    if (isGuard(u)) { out.push(guardBase(u, view, game, ai)); continue; }

    if (lowHp(u) && u.distToBase > 6) {
      const h = goHome(u, view, game, ai); if (h) { out.push(h); continue; }
    }

    const adj = enemies.find(e => chebyshev(e, u) <= RULES.engageRange);
    if (adj) { out.push({ unit: u.id, type: 'attack', target: adj.id }); continue; }

    // 步兵 2、3 号专职抢要塞
    const no = Number(u.id.slice(1));
    if (no === 2) {
      const pool = mine.length ? mine : ownFort;
      const fort = nearest(u, pool);
      if (fort.target && fort.distance <= 26) {
        const path = stepToward(u, fort.target, game, view.moveRange);
        if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
      }
    }

    const spring = trySpring(u, view, game, 5);
    if (spring) { out.push(spring); continue; }

    const got = tryHarvest(u, view, game, 3);
    if (got) { out.push(got); continue; }

    // 中后期分一半兵力穿插敌方领土：走过即翻旗，还能围出没有守军的孤岛
    if (game.turn > game.maxTurns * 0.25 && no === 4) {
      const t = enemyLandTarget(game, ai, u, view.moveRange * 3);
      if (t) {
        const path = stepToward(u, t, game, view.moveRange);
        if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
      }
    }

    // 其余兵力以自家基地为圆心稳步外扩（比经济人快一档）
    const n = Math.max(3, view.unitsAlive - 3);
    const slot = (no - 4 + n * 2) % n;
    const radius = Math.min(25, 4 + game.turn * 0.24);
    const path = ringPath(u, base, radius, game.turn, view.moveRange, slot, n, game);
    if (path) { out.push({ unit: u.id, type: 'move', path }); continue; }
    out.push({ unit: u.id, type: 'defend' });
  }

  maybeProduce(view, out);
  return out;
}

/* ---------------- D 龟缩者 ---------------- */

function turtleActions(view, game, ai) {
  const out = [];
  const base = game.bases[ai];
  const enemies = enemyList(game, ai);
  // 末期评估：领土不领先就派 2 个兵去偷最弱的邻居
  const endgame = game.turn > game.maxTurns * 0.7;
  const ranked = [...AI_IDS].sort((a, b) => game.territoryCount[b] - game.territoryCount[a]);
  const behind = ranked.indexOf(ai) > 0;
  const weakest = ranked[ranked.length - 1];
  const raid = endgame && behind && weakest !== ai && game.bases[weakest]?.alive ? game.bases[weakest] : null;

  for (const u of view.units) {
    if (isGuard(u)) { out.push(guardBase(u, view, game, ai)); continue; }

    // 只打贴脸的
    const adj = enemies.find(e => chebyshev(e, u) <= RULES.engageRange);
    if (adj) { out.push({ unit: u.id, type: 'attack', target: adj.id }); continue; }

    const near = nearest(u, enemies);
    if (near.target && near.distance <= 3 && u.hp > u.maxHp * 0.6) {
      const path = stepToward(u, near.target, game, view.moveRange);
      if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
    }

    if (lowHp(u)) { const h = goHome(u, view, game, ai); if (h) { out.push(h); continue; } }

    if (view.stock < view.unitCost) {
      const use = tryHarvest(u, view, game, 5);
      if (use) { out.push(use); continue; }
    }

    if (raid && [2, 3].includes(Number(u.id.slice(1)))) {
      const path = stepToward(u, raid, game, view.moveRange);
      if (path.length) { out.push({ unit: u.id, type: 'move', path }); continue; }
    }

    // 贴家密垦：半径 3 → 20，慢慢往外糊
    const n = Math.max(4, view.unitsAlive - 1);
    const slot = (Number(u.id.slice(1)) - 2 + n) % n;
    const radius = Math.min(24, 4 + game.turn * 0.21);
    const path = ringPath(u, base, radius, game.turn, view.moveRange, slot, n, game);
    if (path) { out.push({ unit: u.id, type: 'move', path }); continue; }
    out.push({ unit: u.id, type: 'defend' });
  }

  maybeProduce(view, out);
  return out;
}
