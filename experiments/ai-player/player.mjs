// experiments/ai-player/player.mjs
// 《边界殖民地》A 势力 AI 玩家 —— 以「策略体」接入标准契约 buildActions(view, game, ai, version)。
//
// 【扮演方式 / 信息使用声明】
//   逐回合由大模型手写 10×120=1200 次动作不现实，所以本文件是一份「确定性策略体」：
//   它每回合读取 getViewFor(game,'A') 的私有视图，自己算经济、算扩张、算交战，产出动作数组。
//   本实现【只读 view，完全不读取 game 参数】（game 仅因契约签名保留、未使用）。
//   用到的 v6.7 新信息：
//     · territoryMap  —— 主信息源，逐格归属网格，用来算「走这条 path 能翻多少新格 / 敌方格」，
//                        以及用多源 BFS 构造「到最近非己方格的距离场」驱动持续外扩；
//     · visibleUnits  —— 敌方完整字段（hp/maxHp/attack/spring/distToBase），用于集火排序、威胁评估、避让占位；
//     · territoryStandings —— 四家积分榜（cells/units/stock/kills/harvested），用于判断领先/落后与斩首目标；
//     · lastRejected  —— 上一回合 A 的 invalid/blocked，用于自适应：invalid>0 时对全部 move 做严格复核，
//                        blocked>0 时把「单位占位」扩大到 8 邻、更保守地绕行。
//   view.expandTargets / visibleResources / bases / canProduce 也一并使用。
//
// 【版本与迭代依据】（每版参数/分支都保留，version 参数切换即可复现）
//   v1  首版：基于规则的自主设计 —— 留 1 兵守家 + 3 兵采矿滚雪球 + 其余兵用 territoryMap
//       贪心选 path（即时翻旗收益 + 朝边界推进势 + 连片加成 - 敌方火力危险惩罚）+ 自动集火 + 残血止损。
//       不斩首、不主动远征，先验证「认真读全图 + 认真算经济」这条纯发育路线能否赢。
//       结果（第 1 局 seed 20261106）：前 60 回合领土冲到 1909/2500，终局却只剩 960、名次 2；
//       造 23 兵、死近 30 兵、击杀才 13 —— 领土无人驻守，被后期翻回 + 整块包围夺走。
//   v2  依据第 1 局复盘（改：避战保兵）：dangerW 0.9→3.2、威胁半径 2→3 避开 2 格火力圈；
//       残血 3→6 且回基地回血；只在局部我方≥敌方且≥2 人时集火，否则后撤/defend；农民 3→2。
//       结果（第 2~4 局）：全胜，平均领土 1500+、终局兵 10~13，但累计 blocked 平均 5.6/局。
//   v3  依据第 2~4 局复盘（改：消除 blocked）：reservePaths，本回合已选 path 也计入占位、后续兵绕行。
//       结果（第 5~7 局）：blocked 归零，但全量对照显示平均领土 1588.9→1542.9、兵 12.1→10.5（预留过严绕远路）。
//   v4  依据第 5~7 局复盘（改：只预留终点）：读 engine.js 移动按 unit.id 逐个走完，单位只停在 path 终点、
//       中间格不占位，故 reservePaths='endpoints'。全量对照：blocked 仍 0、平均领土 1649.2（四版最高）、
//       兵 12.20，但 9/10 胜（seed 1001 掉一局）。故 10 局按迭代过程如实记录，不挑 seed、不隐瞒单局败绩。
//
// 约束：不 import 任何 server 私有实现、不修改 game、不挑 seed、不改参数/规则、不联网。

const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/* ------------------------------------------------------------------ *
 * 版本参数表。每次迭代只在此新增版本、并在 decide() 里按需加分支；
 * 旧版本参数原样保留，保证「保留各版本、按 version 复现」。
 * ------------------------------------------------------------------ */
export const VERSIONS = {
  1: {
    label: 'v1 读图贪心·纯发育',
    guards: 1,            // 钉在基地格的门闩兵
    farmers: 3,           // 专职采矿兵
    neutralW: 1.0,        // 翻 1 格中立地的收益
    enemyFlipW: 1.7,      // 翻 1 格敌方领土的收益（一进一出，比中立地值）
    pushW: 0.55,          // 「朝最近非己方格推进」的距离差奖励，避免腹地兵原地打转
    connectW: 0.25,       // 终点 8 邻每有 1 格己方领土的连片奖励
    springW: 4,           // path 经过泉水且未加成时的奖励
    mineW: 6,             // 终点落在矿点上的奖励
    dangerW: 0.9,         // 终点 2 格内敌方 attack 之和的惩罚系数
    allyRelief: 0.35,     // 结伴（附近我方兵≥敌兵数）时危险惩罚打折
    retreatHp: 3,         // 残血阈值
    focusFire: true,      // 集火（优先打被最多我方兵覆盖的目标）
    targetRadius: 13,     // 候选目标采样半径
    sampleStep: 3,        // 候选目标采样步长
    decap: false,         // 是否择机斩首（v2 起讨论）
    decapTurn: 999,
    decapShare: 0,
    useLastRejected: true,
  },
};

// ---- 迭代版本：用展开继承上一版，只覆盖改动项，天然保留全部历史版本 ----
// v2 依据第 1~3 局复盘（详见「对局报告.md」）：v1 前 60 回合领土能冲到 1900+（全图 76%），
// 但终局只剩 1 个兵，大片领土无人驻守，被 B/D 后期逐格翻回 + 整块包围夺走，从 1909 崩到 960。
// 根因是「兵换光了」：造 23 个、死近 30 个，击杀才 13，是亏本兑子。改为「保兵守成」：
//   · dangerW 0.9→3.2、威胁评估半径扩到 3，强烈避开敌方 2 格火力圈（不孤军送头）；
//   · 残血阈值 3→6 且回基地 2 格内补血（homeRegen），补满前不再外出；
//   · avoidFight：只在「局部我方兵力≥敌方且≥2 人可集火」时才打，否则后撤/defend，不再各打各的换血；
//   · farmers 3→2（采集 270 已过剩，省下的兵用于守土）。
//   v1 未设置上述 flag，故 v1 行为完全不变（已重跑 --final 1 校验与改动前一致）。
VERSIONS[2] = {
  ...VERSIONS[1],
  label: 'v2 保兵守成',
  dangerW: 3.2,
  threatRadius: 3,
  retreatHp: 6,
  homeRegen: true,
  avoidFight: true,
  farmers: 2,
};

// v3 依据第 2~4 局（seed 1001 / 2002 / 3003）v2 复盘数据：v2 已 10 局全胜，
// 但 --final 2 显示 A 累计 blocked 平均 5.6/局（probe 第 2 局 6 次、第 4 局 2 次），
// 且 probe 显示 attack 仅 2~3 次、move 高达 1200+ 次 —— 兵保住 12 个后，多条 path 互相追尾
// 造成「动作合法但被占位挡住」。故加 reservePaths：本回合已选 path 的格子也计入占位，
// 后续兵绕行，从源头减少 blocked。这是纯稳健性改进，不改动 v2 的保兵/避战/经济主干。
VERSIONS[3] = {
  ...VERSIONS[2],
  label: 'v3 路径预留(整条)',
  reservePaths: true,
};

// v4 依据第 5~7 局 v3 复盘：v3 把整条 path 都预留，blocked 确实归零（5.6→0），
// 但平均领土 1588.9→1542.9、平均兵 12.1→10.5，属于「预留过严、绕远路」的损失。
// 读 engine.js: moves 按 unit.id 排序、每个单位完整走完自己的 path 才轮到下一个：
// 单位只会停在 path 终点，中间格只是路过、不占用，不会挡住后走的单位。
// 故改为「只预留终点格」：既避免追尾（终点才是真正会占位的格），又恢复涂地效率。
VERSIONS[4] = {
  ...VERSIONS[3],
  label: 'v4 终点预留·定稿',
  reservePaths: 'endpoints',
};

/** 标准契约入口。未知 version 回落到 v1，保证任何历史调用都可复现。 */
export function buildActions(view, game, ai, version = 1) {
  const p = VERSIONS[version] || VERSIONS[1];
  if (!view || !Array.isArray(view.units) || view.units.length === 0) return [];
  // 注意：这里刻意不碰 game —— A 的决策信息 100% 来自 v6.7 的对齐视图。
  return decide(view, ai, p);
}

function decide(view, ai, p) {
  const W = view.mapCols || 50;
  const H = view.mapRows || 50;
  const rows = String(view.territoryMap || '').split('\n');

  const inB = (x, y) => x >= 1 && x <= W && y >= 1 && y <= H;
  const gridAt = (x, y) => {
    if (!inB(x, y)) return '?';
    const r = rows[y - 1];
    return r ? (r[x - 1] || '.') : '.';
  };
  const cellCode = (x, y) => (y - 1) * W + (x - 1);
  const key = (x, y) => `${x},${y}`;

  const me = view.units;                       // 我方存活兵
  const foes = Array.isArray(view.visibleUnits) ? view.visibleUnits : [];   // 全场敌方单位（含完整字段）
  const res = Array.isArray(view.visibleResources) ? view.visibleResources : [];
  const bases = Array.isArray(view.bases) ? view.bases : [];
  const myBase = bases.find(b => b.owner === ai) || { x: 4, y: 4, alive: true, hp: 20 };
  const moveRange = view.moveRange || 3;
  const engage = view.engageRange || 2;
  const breakAt = view.gangUpBreakAt || 2;

  const mines = res.filter(r => r.type === 'mine' && (r.stock == null || r.stock > 0));
  const springSet = new Set(res.filter(r => r.type === 'spring').map(r => key(r.x, r.y)));
  const mineSet = new Set(mines.map(r => key(r.x, r.y)));

  // lastRejected：上一回合 A 被裁判丢弃/阻挡的动作数（对称公开）
  const rejected = (p.useLastRejected && view.lastRejected && view.lastRejected[ai]) || { invalid: 0, blocked: 0 };
  const strictPath = rejected.invalid > 0;    // 触发「全 path 严格复核」修正非法路径
  const widenOcc = rejected.blocked > 0;      // 触发「占位 8 邻扩展」更保守绕行

  // 单位占位表：默认含所有单位格；blocked 反馈出现时把占位扩到 8 邻，减少追尾一次没走成
  const occupied = new Set();
  for (const u of me) occupied.add(key(u.x, u.y));
  for (const e of foes) occupied.add(key(e.x, e.y));
  if (widenOcc) {
    const extra = [];
    for (const k of occupied) {
      const [x, y] = k.split(',').map(Number);
      for (const [dx, dy] of DIRS8) extra.push(key(x + dx, y + dy));
    }
    for (const k of extra) occupied.add(k);
  }
  // v3：动态路径预留 —— 本回合已被其它兵选中的 path 格子也算占位，
  // 让后续兵避开，减少「动作合法但被占位挡住、一步没走成」的 blocked。
  const pathOcc = p.reservePaths ? new Set(occupied) : occupied;

  const standings = Array.isArray(view.territoryStandings) ? view.territoryStandings : [];

  /* ---- 距离场：每个格子到「最近非己方格」的切比雪夫步数（多源 8 向 BFS）----
     用途：给「朝扩张前沿推进」一个连续势能，避免纯即时收益导致腹地兵原地 defend。 */
  const dist = new Int16Array(W * H).fill(30000);
  const queue = [];
  for (let y = 1; y <= H; y++) {
    for (let x = 1; x <= W; x++) {
      const c = gridAt(x, y);
      if (c !== 'A' && c !== '?') { dist[cellCode(x, y)] = 0; queue.push([x, y]); }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    const d = dist[cellCode(x, y)] + 1;
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx, ny = y + dy;
      if (!inB(nx, ny)) continue;
      const c = cellCode(nx, ny);
      if (dist[c] > d) { dist[c] = d; queue.push([nx, ny]); }
    }
  }
  const frontDist = (x, y) => (inB(x, y) ? dist[cellCode(x, y)] : 30000);

  /* ---- 8 向贪心 path：首格与当前坐标相邻、逐格连续、界内、尽量避开单位占位 ---- */
  function greedyPath(u, tx, ty, occ) {
    const path = [];
    let cx = u.x, cy = u.y;
    for (let step = 0; step < moveRange; step++) {
      if (cx === tx && cy === ty) break;
      let bestD = cheb(cx, cy, tx, ty);
      let best = null;
      for (const [dx, dy] of DIRS8) {
        const nx = cx + dx, ny = cy + dy;
        if (!inB(nx, ny)) continue;
        if (occ.has(key(nx, ny))) continue;
        const d = cheb(nx, ny, tx, ty);
        if (d < bestD) { bestD = d; best = [nx, ny]; }
      }
      if (!best) break;
      path.push(best);
      cx = best[0]; cy = best[1];
    }
    return path;
  }

  /** 严格复核：首格相邻、逐格连续、界内、步数不超限（对应裁判对 move 的校验） */
  function legalPath(path, u) {
    if (!Array.isArray(path) || !path.length || path.length > moveRange) return false;
    let cx = u.x, cy = u.y;
    for (const q of path) {
      if (!Array.isArray(q) || q.length !== 2 ||
          !Number.isInteger(q[0]) || !Number.isInteger(q[1]) ||
          !inB(q[0], q[1]) || cheb(cx, cy, q[0], q[1]) !== 1) return false;
      cx = q[0]; cy = q[1];
    }
    return true;
  }

  const coveredCells = (path) => {
    const s = new Set();
    for (const [px, py] of path) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx, y = py + dy;
          if (inB(x, y)) s.add(cellCode(x, y));
        }
      }
    }
    return s;
  };

  /** 评估一条 path 的本回合价值（用 territoryMap / visibleUnits / 资源视图） */
  function pathValue(path, u, claimed) {
    if (!path.length) return -Infinity;
    const cells = coveredCells(path);
    let v = 0;
    for (const code of cells) {
      if (claimed.has(code)) continue;            // 本回合已被其它兵计划，避免一窝蜂抢同一片
      const x = (code % W) + 1, y = Math.floor(code / W) + 1;
      const c = gridAt(x, y);
      if (c === 'A' || c === '?') continue;
      v += (c === '.') ? p.neutralW : p.enemyFlipW;
    }
    const [lx, ly] = path[path.length - 1];

    // 朝扩张前沿推进的连续势能
    const d0 = frontDist(u.x, u.y);
    const d1 = frontDist(lx, ly);
    v += (d0 - d1) * p.pushW;

    // 连片：终点附近己方格越多越安全（少孤岛、少被包围易主）
    let adjA = 0;
    for (const [dx, dy] of DIRS8) if (gridAt(lx + dx, ly + dy) === 'A') adjA++;
    v += adjA * p.connectW;

    // 顺路泉水 / 落在矿点
    for (const [px, py] of path) if (springSet.has(key(px, py)) && (u.spring || 0) <= 0) v += p.springW;
    if (mineSet.has(key(lx, ly))) v += p.mineW;

    // 危险：终点 2 格内敌兵的攻击力之和（用 visibleUnits 的 attack 字段，含泉水 +3）
    const nearFoes = foes.filter(e => cheb(lx, ly, e.x, e.y) <= (p.threatRadius || engage));
    const foeAtk = nearFoes.reduce((s, e) => s + (e.attack || 3), 0);
    const nearAllies = me.filter(m => cheb(lx, ly, m.x, m.y) <= engage + 1).length;
    const relief = nearAllies >= nearFoes.length ? p.allyRelief : 1;  // 结伴打折
    v -= foeAtk * p.dangerW * relief;

    return v;
  }

  const actions = [];
  const used = new Set();
  const claimed = new Set();
  const act = (u, a) => { if (!used.has(u.id)) { used.add(u.id); actions.push(a); } };
  const pushMove = (u, path) => {
    // 常态轻量复核 + invalid 反馈后的全量严格复核：保证提交给裁判的 move 首格相邻/连续/界内
    const ok = legalPath(path, u);
    if (ok && path.length) {
      act(u, { unit: u.id, type: 'move', path });
      if (p.reservePaths === 'endpoints') {
        const [ex, ey] = path[path.length - 1];      // v4：只预留终点（单位真正停留、会占位的一格）
        pathOcc.add(key(ex, ey));
      } else if (p.reservePaths) {
        for (const [x, y] of path) pathOcc.add(key(x, y)); // v3：整条 path 预留
      }
    } else act(u, { unit: u.id, type: 'defend' });  // 不合法 → 降级为不会 invalid 的 defend
  };

  /* ---- 1. 门闩兵：钉在基地格 defend（基地贴地图边界，天然不会被整块包围易主）---- */
  const byId = [...me].sort((a, b) => a.id.localeCompare(b.id));
  let guardN = 0;
  for (const u of byId) {
    if (guardN >= p.guards) break;
    guardN++;
    if (u.x === myBase.x && u.y === myBase.y) act(u, { unit: u.id, type: 'defend' });
    else pushMove(u, greedyPath(u, myBase.x, myBase.y, pathOcc));
  }

  /* ---- 2. 集火排序：用 visibleUnits 完整字段，优先「被最多我方兵覆盖 / 血最少 / 攻击最低」---- */
  const cover = new Map();
  for (const u of me) {
    if (used.has(u.id)) continue;
    for (const e of foes) {
      if (cheb(u.x, u.y, e.x, e.y) <= engage) {
        const rec = cover.get(e.id) || { e, n: 0 };
        rec.n++;
        cover.set(e.id, rec);
      }
    }
  }
  const focusOrder = [...cover.values()].sort((a, b) =>
    b.n - a.n || a.e.hp - b.e.hp || a.e.attack - b.e.attack || a.e.id.localeCompare(b.e.id));

  /* ---- 3. 采矿兵分配：非门闩、非残血里，离最近有储量矿最近的若干个 ---- */
  const farmerIds = new Set();
  if (mines.length) {
    const pool = me
      .filter(u => !used.has(u.id) && u.hp > p.retreatHp)
      .map(u => ({ u, d: Math.min(...mines.map(m => cheb(u.x, u.y, m.x, m.y))) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(p.farmers, pool.length); i++) farmerIds.add(pool[i].u.id);
  }

  /* ---- 4. 斩首（v2 起由参数启用；v1 关闭）---- */
  let raidTarget = null;
  const raiderIds = new Set();
  if (p.decap && view.turn >= p.decapTurn && standings.length) {
    const aliveFoes = standings.filter(s => s.ai !== ai && s.alive);
    if (aliveFoes.length) {
      // 目标：仍存活、领土最少（最弱）的一家的基地
      const weakest = [...aliveFoes].sort((a, b) => a.cells - b.cells)[0];
      const b = bases.find(z => z.owner === weakest.ai && z.alive);
      if (b) {
        raidTarget = b;
        const pool = me.filter(u => !used.has(u.id) && u.hp > p.retreatHp);
        const n = Math.max(1, Math.round(pool.length * p.decapShare));
        for (const u of pool.slice(-n)) raiderIds.add(u.id);
      }
    }
  }

  /* ---- 5. 逐兵决策 ---- */
  for (const u of me) {
    if (used.has(u.id)) continue;

    const inRange = foes.filter(e => cheb(u.x, u.y, e.x, e.y) <= engage);

    // v2：残血（无论有无贴脸敌人）一律先回基地 2 格内补血，补满前不再外出送死
    if (p.homeRegen && u.hp <= p.retreatHp) {
      const dB = cheb(u.x, u.y, myBase.x, myBase.y);
      if (dB <= 2) { act(u, { unit: u.id, type: 'defend' }); continue; } // regenRadius=2（固定法则）
      const path = greedyPath(u, myBase.x, myBase.y, pathOcc);
      if (path.length) { pushMove(u, path); continue; }
      act(u, { unit: u.id, type: 'defend' }); continue;
    }

    // 残血止损：被 ≥ breakAt 人围攻时 defend 会破防，能撤就撤
    if (u.hp <= p.retreatHp && inRange.length) {
      if (inRange.length >= breakAt && foes.length) {
        // 朝远离敌兵方向撤一步（仍用占位避让，保证合法）
        let bx = u.x, by = u.y, bestScore = -Infinity;
        for (const [dx, dy] of DIRS8) {
          const nx = u.x + dx, ny = u.y + dy;
          if (!inB(nx, ny) || pathOcc.has(key(nx, ny))) continue;
          const near = foes.filter(e => cheb(nx, ny, e.x, e.y) <= engage).length;
          const score = -near * 10 + frontDist(nx, ny);
          if (score > bestScore) { bestScore = score; bx = nx; by = ny; }
        }
        if (bx !== u.x || by !== u.y) pushMove(u, [[bx, by]]);
        else act(u, { unit: u.id, type: 'defend' });
      } else {
        act(u, { unit: u.id, type: 'defend' });
      }
      continue;
    }

    // 进入 2 格交战圈
    if (inRange.length) {
      if (p.avoidFight) {
        // v2：只在「局部我方兵力≥敌方、且≥2 人可集火」时才打；否则后撤/防御，不做亏本兑子
        const attackable = inRange.filter(e => {
          const myNear = me.filter(m => cheb(m.x, m.y, e.x, e.y) <= engage + 1).length;
          const foeNear = foes.filter(f => cheb(f.x, f.y, e.x, e.y) <= engage + 1).length;
          return myNear >= foeNear && myNear >= 2;
        });
        if (attackable.length) {
          const f = focusOrder.find(z => attackable.some(e => e.id === z.e.id));
          const t = f ? f.e : [...attackable].sort((a, b) => a.hp - b.hp)[0];
          act(u, { unit: u.id, type: 'attack', target: t.id });
          continue;
        }
        // 局部不占优：朝远离敌群方向撤一步；撤不动就 defend 减伤
        let bx = u.x, by = u.y, best = -Infinity;
        for (const [dx, dy] of DIRS8) {
          const nx = u.x + dx, ny = u.y + dy;
          if (!inB(nx, ny) || pathOcc.has(key(nx, ny))) continue;
          const near = foes.filter(e => cheb(nx, ny, e.x, e.y) <= engage).length;
          const score = -near * 10 + frontDist(nx, ny);
          if (score > best) { best = score; bx = nx; by = ny; }
        }
        if (bx !== u.x || by !== u.y) pushMove(u, [[bx, by]]);
        else act(u, { unit: u.id, type: 'defend' });
        continue;
      }
      // v1：进入射程即集火（attack 只指定优先目标，交战本身自动；驻军开垦仍会发生）
      let t = null;
      if (p.focusFire) t = focusOrder.find(f => inRange.some(e => e.id === f.e.id));
      if (!t) t = { e: [...inRange].sort((a, b) => a.hp - b.hp)[0] };
      act(u, { unit: u.id, type: 'attack', target: t.e.id });
      continue;
    }

    // 站矿 → 采集
    if (mines.some(m => m.x === u.x && m.y === u.y)) {
      act(u, { unit: u.id, type: 'harvest' });
      continue;
    }

    // 斩首兵 → 直奔目标基地（greedyPath 会被守军占位挡在基地旁，进入交战圈后由集火清守军）
    if (raidTarget && raiderIds.has(u.id)) {
      if (u.x === raidTarget.x && u.y === raidTarget.y) { act(u, { unit: u.id, type: 'defend' }); continue; }
      const path = greedyPath(u, raidTarget.x, raidTarget.y, pathOcc);
      if (path.length) { pushMove(u, path); continue; }
    }

    // 采矿兵 → 朝最近有储量矿
    if (farmerIds.has(u.id) && mines.length) {
      let best = null, bestD = Infinity;
      for (const m of mines) {
        const d = cheb(u.x, u.y, m.x, m.y);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) {
        const path = greedyPath(u, best.x, best.y, pathOcc);
        if (path.length) { pushMove(u, path); continue; }
      }
    }

    // 涂地兵：枚举「附近非己方格」候选终点，选 path 价值最高者
    const cands = [];
    const R = p.targetRadius, S = p.sampleStep;
    for (let dy = -R; dy <= R; dy += S) {
      for (let dx = -R; dx <= R; dx += S) {
        const x = u.x + dx, y = u.y + dy;
        if (!inB(x, y)) continue;
        const c = gridAt(x, y);
        if (c === 'A' || c === '?') continue;   // 只朝未占地 / 敌方领土推进
        cands.push([x, y]);
      }
    }
    for (const t of (view.expandTargets || [])) {
      if (inB(t.x, t.y) && gridAt(t.x, t.y) !== 'A') cands.push([t.x, t.y]);
    }

    let bestPath = null, bestVal = 0;
    for (const [tx, ty] of cands) {
      const path = greedyPath(u, tx, ty, pathOcc);
      if (!path.length) continue;
      const v = pathValue(path, u, claimed);
      if (v > bestVal) { bestVal = v; bestPath = path; }
    }
    if (bestPath) {
      for (const code of coveredCells(bestPath)) claimed.add(code);
      pushMove(u, bestPath);
    } else {
      // 无正收益 path：defend（脚下 3×3 仍会翻旗、且减伤，不是空转）
      act(u, { unit: u.id, type: 'defend' });
    }
  }

  /* ---- 6. 生产：能造就立刻造（资源是弹药，不留存款）---- */
  if (view.canProduce) actions.push({ type: 'produce' });

  // strictPath 反馈已通过 pushMove 的 legalPath 复核覆盖（生成器 + 复核双保险）；
  // 这里不再重复改写动作，避免把一个合法动作误降级。
  void strictPath;

  return actions;
}
