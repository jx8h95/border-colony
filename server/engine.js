// server/engine.js — 边界殖民地 v6.1
// 纯规则裁判：无 IO，随机可注入种子，所有玩法参数集中在 game.cfg。
//
// 占领
//   士兵每走过一格 → 该格 + 周边 8 格重新归己方（含敌方领土，走过即翻旗）。
//   驻足的士兵同样每回合开垦脚下 3×3。
//   击杀会在阵亡点 3×3 易主；攻陷基地则全部领土易主。
//
// 包围（每回合结算一次，基于快照，不连锁）
//   1) 中立格四个正交邻格同属一家 → 归该家（地图边界不算围墙）。
//   2) 己方连通块被单一敌家从 8 向完全包住、且块内没有己方士兵 → 整块易主。
//
// v6.1 已彻底取消结盟：四家彼此永远敌对。
//
// 士兵
//   v6.6 起血量固定：上限恒为 unitHp，不再随离基地距离衰减（RULES.fixedHp = true）。
//   基地 2 格内每回合回血；攻击力 = attack + 泉水加成（踩过泉水格后若干回合内有效），与距离无关。
//   交战：敌对士兵切比雪夫距离 ≤ engageRange(2) 自动互射；同一目标被 N 人围攻时
//   每个攻击者伤害 +（N-1）（上限 +3），且被 ≥2 人围攻时 defend 的减伤失效。
//
// 胜负
//   1) 只剩一家基地 → 征服胜利，立即结束
//   2) 回合耗尽 → 领土最多者胜；同分比单位数 → 采集量 → 击杀数

import 'dotenv/config';

/* ---------------- 地图与势力 ---------------- */

export const MAP_W = 50;
export const MAP_H = 50;
export const CELLS = MAP_W * MAP_H;
export const AI_IDS = ['A', 'B', 'C', 'D'];

export const OWNER_CODE = { A: 1, B: 2, C: 3, D: 4 };
export const CODE_OWNER = ['', 'A', 'B', 'C', 'D'];
/** 障碍格在 territory 网格里的编码：不是任何一家的领土，永不被涂色 */
export const WALL_CODE = 5;
/** 黄金矿固定在地图正中央，占 1 格 */
export const GOLD_POS = { x: Math.ceil(MAP_W / 2), y: Math.ceil(MAP_H / 2) };

export const FACTION_NAME = { A: '深蓝', B: '珊瑚', C: '青绿', D: '金黄' };

/* ---------------- 可调参数 ---------------- */

/** 默认值 */
export const CFG_DEF = {
  turns: 120,
  unitsPerAI: 6,      // 初始士兵数
  maxUnits: 14,       // 士兵上限
  unitHp: 10,         // 士兵初始血量（基地旁的上限）
  hpDecay: 1.5,       // 血量衰减率（% / 格）
  attack: 3,          // 初始攻击力
  moveRange: 3,       // 移动力
  unitCost: 12,       // 生产消耗
  mines: 24,          // 矿点数量
  springs: 10,        // 泉水数量
  fortresses: 5,      // 要塞数量
  baseHp: 20,         // 基地耐久
  siege: 12,          // 每个围攻单位每回合削减的耐久
  wallRatio: 8,       // 障碍占总格数的百分比（硬上限 10）
  goldYield: 2,       // 中央黄金矿持有者每回合获得的资源
};

/** 上下限：[min, max, step] —— 前后端共用 */
export const CFG_LIMITS = {
  turns: [10, 2000, 10],
  unitsPerAI: [2, 16, 1],
  maxUnits: [4, 40, 1],
  unitHp: [4, 40, 1],
  hpDecay: [0, 8, 0.5],
  attack: [1, 10, 1],
  moveRange: [1, 8, 1],
  unitCost: [4, 40, 1],
  mines: [6, 60, 1],
  springs: [0, 30, 1],
  fortresses: [0, 12, 1],
  baseHp: [10, 100, 5],
  siege: [2, 30, 1],
  wallRatio: [0, 10, 1],
  goldYield: [0, 8, 1],
};

export const CFG_LABEL = {
  turns: '回合数',
  unitsPerAI: '初始士兵数',
  maxUnits: '士兵上限',
  unitHp: '士兵血量',
  hpDecay: '血量衰减 %/格（固定血量下不生效）',
  attack: '初始攻击力',
  moveRange: '移动力',
  unitCost: '生产消耗',
  mines: '矿点数量',
  springs: '泉水数量',
  fortresses: '要塞数量',
  baseHp: '基地耐久',
  siege: '围攻伤害',
  wallRatio: '障碍占比 %（上限 10）',
  goldYield: '黄金矿每回合产出',
};

/** 固定法则（不开放调节，避免玩法崩坏） */
export const RULES = {
  claimRadius: 1,        // 走过的格子 + 周边 8 格
  producePerTurn: 1,
  startStock: 12,
  harvestYield: 3,
  mineStock: 5,
  springAtk: 3,          // 泉水攻击加成
  springTurns: 4,        // 加成持续回合
  regenNearBase: 2,      // 基地 2 格内每回合回血
  regenRadius: 2,
  vision: 4,             // 局部视野半径（仅在 globalVision = false 时生效）
  globalVision: true,    // 全局视野：所有玩家可见全场单位与资源，不再有战争迷雾
  engageRange: 2,        // 交战距离：切比雪夫距离 ≤ 2 即视为进入交战
  autoEngage: true,      // 自动交战：距离内的敌对士兵每回合自动互射，无需声明 attack
  fixedHp: true,         // 固定血量：血量上限恒为 cfg.unitHp，不再随离基地距离衰减（改 false 恢复旧衰减）
  gangUpBonus: 1,        // 群殴：同一目标每多一个同时攻击者，每个攻击者伤害 +1
  gangUpMaxBonus: 3,     // 群殴加成上限（+3）
  gangUpBreakAt: 2,      // 同时被 N 人以上围攻时，defend 的减伤失效（破防）
  wallMaxRatio: 10,      // 障碍占比硬上限（%），参数面板也用同一个上限
  baseSafeRadius: 4,     // 四家基地周边禁止生成障碍（保证出生环与初始落位）
  goldSafeRadius: 3,     // 中央黄金矿周边禁止生成障碍（保证四家都能走到中央）
};

export function normalizeCfg(input = {}) {
  const cfg = { ...CFG_DEF };
  for (const k of Object.keys(CFG_LIMITS)) {
    const v = Number(input[k]);
    const [min, max] = CFG_LIMITS[k];
    if (Number.isFinite(v)) cfg[k] = Math.min(max, Math.max(min, v));
    else cfg[k] = CFG_DEF[k];
  }
  cfg.turns = Math.floor(cfg.turns);
  cfg.unitsPerAI = Math.floor(cfg.unitsPerAI);
  cfg.maxUnits = Math.floor(cfg.maxUnits);
  cfg.unitHp = Math.floor(cfg.unitHp);
  cfg.attack = Math.floor(cfg.attack);
  cfg.moveRange = Math.floor(cfg.moveRange);
  cfg.unitCost = Math.floor(cfg.unitCost);
  cfg.mines = Math.floor(cfg.mines);
  cfg.springs = Math.floor(cfg.springs);
  cfg.fortresses = Math.floor(cfg.fortresses);
  cfg.baseHp = Math.floor(cfg.baseHp);
  cfg.siege = Math.floor(cfg.siege);
  cfg.wallRatio = Math.floor(cfg.wallRatio);
  cfg.goldYield = Math.floor(cfg.goldYield);
  cfg.hpDecay = Math.round(cfg.hpDecay * 2) / 2;
  cfg.maxUnits = Math.max(cfg.maxUnits, cfg.unitsPerAI);
  return cfg;
}

/* ---------------- 工具 ---------------- */

export const idx = (x, y) => (y - 1) * MAP_W + (x - 1);
export const inBounds = (x, y) => x >= 1 && x <= MAP_W && y >= 1 && y <= MAP_H;

export function createRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/* ---------------- 基地位置 ---------------- */

const BASE_POS = {
  A: { x: 4, y: 4 },
  B: { x: MAP_W - 3, y: 4 },
  C: { x: 4, y: MAP_H - 3 },
  D: { x: MAP_W - 3, y: MAP_H - 3 },
};

/* ---------------- 开局 ---------------- */

export function createGame(seed = 20261106, { turns, cfg } = {}) {
  const conf = normalizeCfg({ ...(cfg || {}), turns: turns ?? cfg?.turns ?? CFG_DEF.turns });
  const rng = createRng(seed);

  const bases = {};
  for (const ai of AI_IDS) {
    bases[ai] = {
      owner: ai,
      x: BASE_POS[ai].x,
      y: BASE_POS[ai].y,
      alive: true,
      hp: conf.baseHp,
      maxHp: conf.baseHp,
    };
  }

  const zero = () => Object.fromEntries(AI_IDS.map(a => [a, 0]));

  const game = {
    seed,
    rngState: seed,
    turn: 0,
    maxTurns: conf.turns,
    cfg: conf,
    over: false,
    winner: null,
    winType: null,
    units: [],
    nextUnitNo: zero(),
    resources: [],
    bases,
    territory: new Uint8Array(CELLS),
    wallCount: 0,
    goldMine: { x: GOLD_POS.x, y: GOLD_POS.y, owner: null, produced: 0 },
    territoryCount: zero(),
    stock: Object.fromEntries(AI_IDS.map(a => [a, RULES.startStock])),
    scores: zero(),
    kills: zero(),
    unitLost: zero(),
    // 上一回合裁判丢弃/中断的动作数：四家对称公开，getViewFor 会回灌给所有玩家
    rejectedByAI: Object.fromEntries(AI_IDS.map(a => [a, { invalid: 0, blocked: 0 }])),
    events: ['游戏开始'],
    history: [],
  };

  // 障碍先落地：之后 paint / 资源 / 出生点都会自动避开它
  generateWalls(game, rng);

  // 出生地：基地为中心 5×5
  for (const ai of AI_IDS) {
    const b = bases[ai];
    paint(game, ai, b.x, b.y, 2);
  }

  // 士兵：1 号站在基地格上（天然守军），其余围着基地落位
  for (const ai of AI_IDS) {
    const b = bases[ai];
    game.nextUnitNo[ai] = conf.unitsPerAI;
    const spots = [{ x: b.x, y: b.y }, ...spawnRing(b)];
    for (let i = 0; i < conf.unitsPerAI; i++) {
      const p = spots[i % spots.length];
      game.units.push({
        id: `${ai}${String(i + 1).padStart(2, '0')}`,
        owner: ai,
        x: p.x, y: p.y,
        hp: maxHpAt(game, ai, p.x, p.y),
        spring: 0,
        alive: true,
      });
    }
  }

  placeResources(game, rng);
  game.history.push(historyEntry(game, 0));
  return game;
}

/** 每回合的参数快照：给侧栏「本回合变化」和趋势图用 */
function historyEntry(game, turn) {
  return {
    turn,
    territory: { ...game.territoryCount },
    units: Object.fromEntries(AI_IDS.map(a => [a, aliveCount(game, a)])),
    stock: { ...game.stock },
    kills: { ...game.kills },
    scores: { ...game.scores },
    gain: { ...(game.territoryGain || Object.fromEntries(AI_IDS.map(a => [a, 0]))) },
    events: [...game.events],
  };
}

/** 基地外圈按距离排序的空位，用于开局与生产 */
function spawnRing(base) {
  const out = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = base.x + dx, y = base.y + dy;
      if (!inBounds(x, y)) continue;
      if (dx === 0 && dy === 0) continue;
      out.push({ x, y, d: Math.max(Math.abs(dx), Math.abs(dy)) * 10 + Math.abs(dx) + Math.abs(dy) });
    }
  }
  out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return out;
}

/** 该格是不是不可通行、不可占领的障碍 */
export function isWall(game, x, y) {
  return inBounds(x, y) && game.territory[idx(x, y)] === WALL_CODE;
}

/**
 * 生成随机连续障碍带（确定性：同 seed 一定得到同一张地图）。
 * 硬约束：占全图比例 ≤ wallMaxRatio（10%）、四家基地周边与中央黄金矿周边留空、
 * 不碰地图最外两圈（保证外圈始终可走）。生成后再做连通性修复，
 * 确保四家基地都能走到中央，不会出现「开局就被墙封死」。
 */
function generateWalls(game, rng) {
  const pct = Math.min(game.cfg.wallRatio, RULES.wallMaxRatio);
  const target = Math.floor(CELLS * pct / 100);
  if (target <= 0) return;

  const safe = (x, y) => {
    if (!inBounds(x, y)) return true;
    if (Math.abs(x - GOLD_POS.x) <= RULES.goldSafeRadius &&
        Math.abs(y - GOLD_POS.y) <= RULES.goldSafeRadius) return true;
    return AI_IDS.some(ai => {
      const b = game.bases[ai];
      return Math.abs(x - b.x) <= RULES.baseSafeRadius &&
             Math.abs(y - b.y) <= RULES.baseSafeRadius;
    });
  };

  const add = (x, y) => {
    if (game.wallCount >= target) return;      // 加厚一步也不许越过目标，确保严格 ≤ 上限
    if (!inBounds(x, y) || safe(x, y)) return;
    const i = idx(x, y);
    if (game.territory[i] === WALL_CODE) return;
    game.territory[i] = WALL_CODE;
    game.wallCount++;
  };

  let guard = 0;
  while (game.wallCount < target && guard++ < 800) {
    // 每段是一条带方向惯性的随机游走，形成连续的一片障碍
    let x = 5 + Math.floor(rng() * (MAP_W - 9));
    let y = 5 + Math.floor(rng() * (MAP_H - 9));
    let di = Math.floor(rng() * DIRS8.length);
    const len = 6 + Math.floor(rng() * 16);
    for (let s = 0; s < len && game.wallCount < target; s++) {
      if (rng() < 0.28) di = (di + (rng() < 0.5 ? 1 : DIRS8.length - 1)) % DIRS8.length;
      const [dx, dy] = DIRS8[di];
      const nx = x + dx, ny = y + dy;
      if (nx < 3 || ny < 3 || nx > MAP_W - 2 || ny > MAP_H - 2) break;
      x = nx; y = ny;
      add(x, y);
      // 偶尔加厚一格，让障碍成片而不是一条细线
      if (rng() < 0.35) {
        const [wx, wy] = DIRS8[(di + 2) % DIRS8.length];
        add(x + wx, y + wy);
      }
    }
  }

  ensureAllReachGold(game);
}

/** 8 向连通修复：基地到中央黄金矿若被墙隔断，清掉最短路上的墙 */
function ensureAllReachGold(game) {
  const goldIdx = idx(GOLD_POS.x, GOLD_POS.y);
  const floodFromGold = () => {
    const seen = new Uint8Array(CELLS);
    const q = [goldIdx];
    seen[goldIdx] = 1;
    while (q.length) {
      const i = q.pop();
      const x = (i % MAP_W) + 1, y = Math.floor(i / MAP_W) + 1;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen[ni] || game.territory[ni] === WALL_CODE) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    return seen;
  };

  for (const ai of AI_IDS) {
    const bi = idx(game.bases[ai].x, game.bases[ai].y);
    if (floodFromGold()[bi]) continue;

    // 允许穿墙地从基地扩散，找到离基地最近的「中央连通片」上的点，清掉沿途的墙
    const dist = new Int32Array(CELLS).fill(-1);
    const prev = new Int32Array(CELLS).fill(-1);
    const q = [bi];
    dist[bi] = 0;
    for (let head = 0; head < q.length; head++) {
      const i = q[head];
      const x = (i % MAP_W) + 1, y = Math.floor(i / MAP_W) + 1;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (dist[ni] >= 0) continue;
        dist[ni] = dist[i] + 1;
        prev[ni] = i;
        q.push(ni);
      }
    }
    const reachable = floodFromGold();
    let best = -1;
    for (const i of q) if (reachable[i] && (best < 0 || dist[i] < dist[best])) best = i;
    if (best < 0) continue;
    for (let i = best; i >= 0 && i !== bi; i = prev[i]) {
      if (game.territory[i] === WALL_CODE) { game.territory[i] = 0; game.wallCount--; }
    }
  }
}

function placeResources(game, rng) {
  const taken = new Set(game.units.map(u => `${u.x},${u.y}`));
  for (const b of Object.values(game.bases)) taken.add(`${b.x},${b.y}`);
  // 障碍格不可布置任何资源；中央黄金矿独占 1 格，也不放普通资源
  for (let i = 0; i < CELLS; i++) {
    if (game.territory[i] === WALL_CODE) {
      taken.add(`${(i % MAP_W) + 1},${Math.floor(i / MAP_W) + 1}`);
    }
  }
  taken.add(`${GOLD_POS.x},${GOLD_POS.y}`);

  const nearBase = (x, y, r) => AI_IDS.some(ai => {
    const b = game.bases[ai];
    return Math.abs(x - b.x) <= r && Math.abs(y - b.y) <= r;
  });

  const put = (type, count, stock) => {
    let placed = 0, guard = 0;
    while (placed < count && guard < count * 400 + 400) {
      guard++;
      const x = 2 + Math.floor(rng() * (MAP_W - 2));
      const y = 2 + Math.floor(rng() * (MAP_H - 2));
      const key = `${x},${y}`;
      if (taken.has(key)) continue;
      if (nearBase(x, y, 5)) continue;
      // 与已有资源保持 2 格间距，避免图标挤在一起
      let crowded = false;
      for (let dy = -2; dy <= 2 && !crowded; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (taken.has(`${x + dx},${y + dy}`) && game.resources.some(r => r.x === x + dx && r.y === y + dy)) {
            crowded = true; break;
          }
        }
      }
      if (crowded) continue;
      taken.add(key);
      game.resources.push({
        id: `r${game.resources.length}`,
        type, x, y,
        stock: stock ?? null,
        claimedBy: null,
      });
      placed++;
    }
  };

  put('mine', game.cfg.mines, RULES.mineStock);
  put('spring', game.cfg.springs, null);
  put('fortress', game.cfg.fortresses, null);
}

/* ---------------- 领土 ---------------- */

/**
 * 以 (cx,cy) 为中心、切比雪夫半径 r 涂色。
 * @param {{onlyNeutral?:boolean}} opts onlyNeutral → 只改中立地，不夺取敌方领土
 * @returns {number} 新增格数
 */
export function paint(game, owner, cx, cy, r, { onlyNeutral = false } = {}) {
  const code = OWNER_CODE[owner];
  if (!code) return 0;
  let gained = 0;
  const x0 = Math.max(1, cx - r), x1 = Math.min(MAP_W, cx + r);
  const y0 = Math.max(1, cy - r), y1 = Math.min(MAP_H, cy + r);

  for (let y = y0; y <= y1; y++) {
    const row = (y - 1) * MAP_W;
    for (let x = x0; x <= x1; x++) {
      const i = row + x - 1;
      const prev = game.territory[i];
      if (prev === WALL_CODE || prev === code) continue;   // 障碍永不可占领
      if (onlyNeutral && prev !== 0) continue;
      if (prev !== 0) game.territoryCount[CODE_OWNER[prev]]--;
      game.territory[i] = code;
      game.territoryCount[owner]++;
      gained++;
    }
  }
  return gained;
}

export function annexTerritory(game, from, to) {
  const fc = OWNER_CODE[from], tc = OWNER_CODE[to];
  if (!fc || !tc) return 0;
  let n = 0;
  const t = game.territory;
  for (let i = 0; i < CELLS; i++) if (t[i] === fc) { t[i] = tc; n++; }
  game.territoryCount[from] = 0;
  game.territoryCount[to] += n;
  return n;
}

/**
 * 包围结算（v6.1）。基于同一份快照判定，避免本回合内连锁吞地。
 *   A 中立格：四个正交邻格同属一家 → 归该家。地图边界不算围墙。
 *   B 己方连通块：8 向完全被同一敌家包住、块内没有己方士兵 → 整块易主。
 * 返回 { filled, flipped }。
 */
export function applyEncirclement(game) {
  const snap = Uint8Array.from(game.territory);
  const changes = [];               // [index, newCode]
  const filled = Object.fromEntries(AI_IDS.map(a => [a, 0]));
  const flipped = Object.fromEntries(AI_IDS.map(a => [a, 0]));
  if (!game.territoryGain) game.territoryGain = Object.fromEntries(AI_IDS.map(a => [a, 0]));
  if (!Array.isArray(game.events)) game.events = [];
  const at = (x, y) => (inBounds(x, y) ? snap[idx(x, y)] : -1);

  /* A. 中立地：四邻同色即填补 */
  for (let y = 1; y <= MAP_H; y++) {
    for (let x = 1; x <= MAP_W; x++) {
      const i = idx(x, y);
      if (snap[i] !== 0) continue;
      const ns = DIRS4.map(([dx, dy]) => at(x + dx, y + dy));
      // 出界 / 中立 / 障碍都不算围墙（墙是地形，不是任何一家的领土）
      if (ns.some(v => v <= 0 || v === WALL_CODE)) continue;
      if (ns.every(v => v === ns[0])) changes.push([i, ns[0]]);
    }
  }

  /* B. 被围的己方连通块 */
  const guards = new Map();          // 格子 index -> 该格驻军势力码（多个取首个）
  for (const u of game.units) {
    if (!u.alive) continue;
    const i = idx(u.x, u.y);
    if (!guards.has(i)) guards.set(i, OWNER_CODE[u.owner]);
  }

  const visited = new Uint8Array(CELLS);
  for (let sy = 1; sy <= MAP_H; sy++) {
    for (let sx = 1; sx <= MAP_W; sx++) {
      const start = idx(sx, sy);
      const code = snap[start];
      // 障碍格直接跳过并标记，不参与任何连通块
      if (code === WALL_CODE) { visited[start] = 1; continue; }
      if (!code || visited[start]) continue;

      // 8 连通 BFS，收集整块
      const cells = [];
      const inBlock = new Set();
      const queue = [[sx, sy]];
      visited[start] = 1;
      let touchesEdge = false;
      let hasGuard = false;

      while (queue.length) {
        const [x, y] = queue.pop();
        const i = idx(x, y);
        cells.push(i);
        inBlock.add(i);
        if (x === 1 || y === 1 || x === MAP_W || y === MAP_H) touchesEdge = true;
        if (guards.get(i) === code) hasGuard = true;

        for (const [dx, dy] of DIRS8) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const ni = idx(nx, ny);
          if (visited[ni] || snap[ni] !== code) continue;
          visited[ni] = 1;
          queue.push([nx, ny]);
        }
      }

      // 贴地图边界的块不算被围（边界不是墙）；块里有自家士兵就守住
      if (touchesEdge || hasGuard) continue;

      // 外围 8 邻必须全是同一个敌家
      let besieger = 0;
      let ok = true;
      for (const i of cells) {
        const x = (i % MAP_W) + 1, y = Math.floor(i / MAP_W) + 1;
        for (const [dx, dy] of DIRS8) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny)) { ok = false; break; }
          const ni = idx(nx, ny);
          if (inBlock.has(ni)) continue;
          const c = snap[ni];
          // 邻到障碍视为有缺口，这块不算被围
          if (c === WALL_CODE || !c || c === code || (besieger && c !== besieger)) { ok = false; break; }
          besieger = c;
        }
        if (!ok) break;
      }
      if (!ok || !besieger) continue;

      for (const i of cells) changes.push([i, besieger]);
    }
  }

  /* 统一落盘，同时维护计数与回合增量 */
  for (const [i, c] of changes) {
    const prev = game.territory[i];
    if (prev === c) continue;
    if (prev) game.territoryCount[CODE_OWNER[prev]]--;
    game.territory[i] = c;
    game.territoryCount[CODE_OWNER[c]]++;
    const owner = CODE_OWNER[c];
    game.territoryGain[owner]++;
    if (snap[i]) flipped[owner]++; else filled[owner]++;
  }

  for (const ai of AI_IDS) {
    if (flipped[ai]) game.events.push(`${ai} 包围夺取 ${flipped[ai]} 格`);
    if (filled[ai]) game.events.push(`${ai} 填补中立地 ${filled[ai]} 格`);
  }
  return { filled, flipped };
}

export function territoryAt(game, x, y) {
  if (!inBounds(x, y)) return null;
  const c = game.territory[idx(x, y)];
  // 障碍不属于任何势力；需要区分「墙」和「中立」时用 isWall()
  return c && c !== WALL_CODE ? CODE_OWNER[c] : null;
}

export function encodeTerritory(game) {
  const t = game.territory;
  let out = '';
  const CHUNK = 4096;
  for (let i = 0; i < t.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, t.length);
    const buf = new Array(end - i);
    for (let j = i; j < end; j++) buf[j - i] = 48 + t[j];
    out += String.fromCharCode.apply(null, buf);
  }
  return out;
}

/* ---------------- 查询 ---------------- */

export function unitAt(game, x, y) {
  return game.units.find(u => u.alive && u.x === x && u.y === y) || null;
}

export function resourceAt(game, x, y) {
  return game.resources.find(r => r.x === x && r.y === y) || null;
}

export function aliveCount(game, ai) {
  let n = 0;
  for (const u of game.units) if (u.alive && u.owner === ai) n++;
  return n;
}

export function factionAlive(game, ai) {
  return !!(game.bases[ai] && game.bases[ai].alive);
}

export function distToBase(game, ai, x, y) {
  const b = game.bases[ai];
  if (!b) return 0;
  return chebyshev({ x, y }, b);
}

/** 某格上、某势力的士兵血量上限
 *  fixedHp = true（默认）：恒为 cfg.unitHp，与离基地距离无关。
 *  fixedHp = false：旧规则，离基地越远上限越低（每格 -hpDecay%，地板 25%）。 */
export function maxHpAt(game, ai, x, y) {
  const cfg = game.cfg;
  if (RULES.fixedHp) return cfg.unitHp;
  const d = distToBase(game, ai, x, y);
  const factor = 1 - (cfg.hpDecay / 100) * d;
  return Math.max(1, Math.round(cfg.unitHp * Math.max(0.25, factor)));
}

export function moveRangeOf(game, ai) {
  return game.cfg.moveRange;
}

export function attackOf(game, unit) {
  return game.cfg.attack + (unit.spring > 0 ? RULES.springAtk : 0);
}

/* ---------------- 回合结算 ---------------- */

export function resolveTurn(game, actionsByAI = {}) {
  if (game.over) return game;

  const turn = game.turn + 1;
  game.turn = turn;
  game.events = [];
  game.territoryGain = Object.fromEntries(AI_IDS.map(a => [a, 0]));
  // 每回合重新计数；上一回合的结果在本次结算前已由 getViewFor 发给所有玩家
  const rejected = Object.fromEntries(AI_IDS.map(a => [a, { invalid: 0, blocked: 0 }]));
  game.rejectedByAI = rejected;

  const rng = createRng((game.rngState || game.seed) ^ (turn * 7919));
  game.rngState = Math.floor(rng() * 1e9);

  const cfg = game.cfg;

  /* 1. 收集与校验动作（v6.1 起没有外交阶段，四家永远敌对） */
  const moves = [];
  const attacks = [];
  const harvests = [];
  const defends = new Set();
  const produceRequests = Object.fromEntries(AI_IDS.map(a => [a, 0]));

  for (const ai of AI_IDS) {
    if (!factionAlive(game, ai)) continue;
    const acts = Array.isArray(actionsByAI[ai]) ? actionsByAI[ai] : [];
    const range = moveRangeOf(game, ai);
    const seen = new Set();   // 裁判层兜底：同一单位一回合只认第一个动作
    // 所有势力共用同一套校验，不做任何「替谁修正」的偏袒处理：
    // 不合法的动作整条丢弃并计数，下一回合通过 view.lastRejected 对称回灌。
    const rejectInvalid = () => { rejected[ai].invalid++; };

    for (const act of acts) {
      if (!act || typeof act !== 'object') { rejectInvalid(); continue; }

      if (act.type === 'produce') {
        if (produceRequests[ai] < RULES.producePerTurn) produceRequests[ai]++;
        else rejectInvalid();
        continue;
      }

      const unit = game.units.find(u => u.id === act.unit && u.alive);
      if (!unit || unit.owner !== ai) { rejectInvalid(); continue; }
      if (seen.has(unit.id)) { rejectInvalid(); continue; }
      seen.add(unit.id);

      if (act.type === 'wait') continue;   // 合法的不动

      if (act.type === 'move') {
        if (!Array.isArray(act.path) || !act.path.length) { rejectInvalid(); continue; }
        const path = act.path.slice(0, range);
        let cur = { x: unit.x, y: unit.y };
        let ok = true;
        for (const p of path) {
          if (!Array.isArray(p) || p.length !== 2 ||
              !Number.isInteger(p[0]) || !Number.isInteger(p[1]) ||
              !inBounds(p[0], p[1]) || isWall(game, p[0], p[1]) ||
              chebyshev(cur, { x: p[0], y: p[1] }) !== 1) {
            ok = false;
            break;
          }
          cur = { x: p[0], y: p[1] };
        }
        // 首格必须与士兵当前坐标相邻、之后逐格连续、全程在界内；
        // 任何一格不合法就整条丢弃（旧版会静默 break 且不给反馈）
        if (!ok) { rejectInvalid(); continue; }
        moves.push({ unit, path });
      } else if (act.type === 'attack') {
        const target = game.units.find(u => u.id === act.target && u.alive);
        // 交战距离 engageRange（默认 2 格）：范围内即可指定目标
        if (target && target.owner !== ai && chebyshev(unit, target) <= RULES.engageRange) {
          attacks.push({ attacker: unit, target });
        } else rejectInvalid();
      } else if (act.type === 'harvest') {
        const res = resourceAt(game, unit.x, unit.y);
        if (res && res.type === 'mine' && res.stock > 0) harvests.push({ unit, res });
        else rejectInvalid();
      } else if (act.type === 'defend') {
        defends.add(unit.id);
      } else {
        rejectInvalid();
      }
    }
  }

  /* 2. 移动：逐格推进，走过的格子 + 周边 8 格重新归己方（含敌方领土） */
  moves.sort((a, b) => a.unit.id.localeCompare(b.unit.id));
  for (const m of moves) {
    if (!m.unit.alive) continue;
    let cur = { x: m.unit.x, y: m.unit.y };
    const from = { x: cur.x, y: cur.y };

    for (const [nx, ny] of m.path) {
      if (Math.max(Math.abs(nx - cur.x), Math.abs(ny - cur.y)) !== 1) break;
      if (isWall(game, nx, ny)) break;                 // 裁判二次兜底：墙不可踏入
      const blocker = unitAt(game, nx, ny);
      if (blocker && blocker.id !== m.unit.id) break;
      cur = { x: nx, y: ny };
      m.unit.x = nx;
      m.unit.y = ny;
      game.territoryGain[m.unit.owner] +=
        paint(game, m.unit.owner, nx, ny, RULES.claimRadius);
    }
    // 动作本身合法、但一步没走成（被其他单位占位挡住）→ 单独记一类反馈
    if (cur.x === from.x && cur.y === from.y) rejected[m.unit.owner].blocked++;
  }

  /* 3. 驻军开垦脚下 3×3（同样会翻掉敌方领土） */
  for (const u of game.units) {
    if (!u.alive) continue;
    game.territoryGain[u.owner] +=
      paint(game, u.owner, u.x, u.y, RULES.claimRadius);
  }

  /* 4. 采集 */
  for (const h of harvests) {
    if (!h.unit.alive || h.res.stock <= 0) continue;
    if (h.unit.x !== h.res.x || h.unit.y !== h.res.y) continue;
    h.res.stock--;
    game.stock[h.unit.owner] += RULES.harvestYield;
    game.scores[h.unit.owner] += RULES.harvestYield;
    if (h.res.stock === 0) {
      game.resources = game.resources.filter(r => r.id !== h.res.id);
      game.events.push('矿点枯竭');
    }
  }

  /* 5. 插旗：要塞主动占领（之后每回合自发扩张） */
  for (const u of game.units) {
    if (!u.alive) continue;
    const res = resourceAt(game, u.x, u.y);
    if (!res || res.type !== 'fortress' || res.claimedBy === u.owner) continue;
    res.claimedBy = u.owner;
    game.events.push(`${u.owner} 占领要塞`);
  }

  /* 6. 泉水：踩过即获得攻击加成 */
  const springPick = new Set();
  for (const u of game.units) {
    if (!u.alive) continue;
    const res = resourceAt(game, u.x, u.y);
    if (res && res.type === 'spring') {
      if (u.spring <= 0) game.events.push(`${u.id} 饮泉水，攻击力提升`);
      u.spring = RULES.springTurns;
      springPick.add(u.id);
    }
  }

  /* 7. 围攻主基地：两阶段结算 */
  // 阶段一：按同一份单位快照算出四家的结果与征服者。旧版边算边杀，
  // A 先亡国会把 A 的单位置死，导致后面 B 的 siegers 凭空消失（互围时先手必输）。
  const siegePlan = [];
  for (const owner of AI_IDS) {
    const base = game.bases[owner];
    if (!base.alive) continue;

    const siegers = game.units.filter(u =>
      u.alive && u.owner !== owner &&
      u.x === base.x && u.y === base.y
    );
    if (!siegers.length) continue;

    const hpAfter = Math.max(0, base.hp - cfg.siege * siegers.length);
    siegePlan.push({ owner, hpAfter, conqueror: hpAfter > 0 ? null : siegers[0].owner });
  }

  // 阶段二：统一执行掉血 / 亡国 / 吞并，判定不再受执行顺序影响
  for (const p of siegePlan) {
    const base = game.bases[p.owner];
    base.hp = p.hpAfter;
    if (!p.conqueror) {
      game.events.push(`${p.owner} 基地被围攻（${base.hp}/${base.maxHp}）`);
      continue;
    }
    base.alive = false;
    let killed = 0;
    for (const u of game.units) {
      if (u.owner === p.owner && u.alive) { u.alive = false; u.hp = 0; killed++; }
    }
    game.unitLost[p.owner] += killed;

    const taken = annexTerritory(game, p.owner, p.conqueror);
    game.territoryGain[p.conqueror] += taken;
    game.events.push(`${p.conqueror} 攻陷 ${p.owner} 主基地，${p.owner} 亡国（${taken} 格易主）`);
  }

  /* 8. 交战结算（同时进行）
     规则：敌对士兵切比雪夫距离 ≤ engageRange（默认 2 格）即自动开火、
     每回合互相打一次，不需要声明 attack。声明了 attack 的单位优先打自己指定的目标，
     否则自动打最近的敌人；选择 defend 的单位本回合不开火（只挨打，伤害减半）。 */
  const declared = new Map();
  for (const a of attacks) declared.set(a.attacker.id, a.target.id);

  const engages = [];
  for (const u of game.units) {
    if (!u.alive) continue;
    const foes = game.units.filter(e =>
      e.alive && e.owner !== u.owner && chebyshev(e, u) <= RULES.engageRange
    );
    if (!foes.length) continue;
    if (!RULES.autoEngage && !declared.has(u.id)) continue;
    if (defends.has(u.id)) continue;

    const want = declared.get(u.id);
    const target = foes.find(e => e.id === want) || foes
      .slice()
      .sort((a, b) =>
        chebyshev(a, u) - chebyshev(b, u) || a.hp - b.hp || a.id.localeCompare(b.id)
      )[0];
    engages.push({ attacker: u, target });
  }

  const damageByUnit = new Map();
  const addDamage = (targetId, dmg, killer) => {
    const prev = damageByUnit.get(targetId) || { dmg: 0, killer: null };
    damageByUnit.set(targetId, { dmg: prev.dmg + dmg, killer: killer || prev.killer });
  };

  /* 群殴计数：同一目标本回合被几个敌对单位同时攻击（用于伤害加成与破防判定） */
  const gangCount = new Map();
  for (const c of engages) {
    if (!c.attacker.alive || !c.target.alive) continue;
    if (chebyshev(c.attacker, c.target) > RULES.engageRange) continue;
    gangCount.set(c.target.id, (gangCount.get(c.target.id) || 0) + 1);
  }

  for (const c of engages) {
    // 收集后到结算前可能有单位阵亡 / 被推离，结算时复核存活与距离
    if (!c.attacker.alive || !c.target.alive) continue;
    if (chebyshev(c.attacker, c.target) > RULES.engageRange) continue;
    const attackers = gangCount.get(c.target.id) || 1;
    // 群殴：每多一个同时攻击者 +gangUpBonus 伤害，封顶 gangUpMaxBonus
    const extra = Math.min(
      RULES.gangUpMaxBonus,
      Math.max(0, attackers - 1) * RULES.gangUpBonus,
    );
    let dmg = attackOf(game, c.attacker) + extra;
    // 破防：被 ≥ gangUpBreakAt 人围攻时，defend 的减伤不再生效
    const surrounded = attackers >= RULES.gangUpBreakAt;
    if (defends.has(c.target.id) && !surrounded) dmg = Math.max(1, Math.ceil(dmg / 2));
    if (resourceAt(game, c.target.x, c.target.y)?.type === 'fortress') dmg = Math.max(1, dmg - 1);
    addDamage(c.target.id, dmg, c.attacker.owner);
  }

  for (const [uid, info] of damageByUnit) {
    const u = game.units.find(x => x.id === uid);
    if (!u || !u.alive) continue;
    u.hp -= info.dmg;
    if (u.hp <= 0) {
      u.hp = 0;
      u.alive = false;
      game.unitLost[u.owner]++;
      if (info.killer) {
        game.kills[info.killer] = (game.kills[info.killer] || 0) + 1;
        // 阵亡地 3×3 易主
        game.territoryGain[info.killer] += paint(game, info.killer, u.x, u.y, RULES.claimRadius);
      }
      game.events.push(`${u.id} 阵亡`);
    }
  }

  /* 8.5 中央黄金矿：站上去即占领，持有者每回合持续获得资源，
     不需要留兵驻守，但任何一家把兵踩上来就能夺走；持有方亡国则矿归无主。 */
  const gm = game.goldMine;
  if (gm) {
    if (gm.owner && !factionAlive(game, gm.owner)) gm.owner = null;
    const holder = game.units.find(u =>
      u.alive && factionAlive(game, u.owner) && u.x === gm.x && u.y === gm.y
    );
    if (holder && holder.owner !== gm.owner) {
      gm.owner = holder.owner;
      game.events.push(`${holder.owner} 占领中央黄金矿`);
    }
    if (gm.owner && cfg.goldYield > 0 && factionAlive(game, gm.owner)) {
      game.stock[gm.owner] += cfg.goldYield;
      gm.produced += cfg.goldYield;
      game.events.push(`${gm.owner} 黄金矿收入 +${cfg.goldYield}`);
    }
  }

  /* 9. 要塞自发扩张（每 4 回合一次，避免一家白拿太多地） */
  for (const res of game.resources) {
    if (turn % 4 !== 0) break;
    if (res.type !== 'fortress' || !res.claimedBy) continue;
    if (!factionAlive(game, res.claimedBy)) continue;
    game.territoryGain[res.claimedBy] +=
      paint(game, res.claimedBy, res.x, res.y, RULES.claimRadius, { onlyNeutral: true });
  }

  /* 10. 包围结算：中立地四邻同色填补 + 无守军的被围连通块整块易主 */
  applyEncirclement(game);

  /* 11. 血量：距离压制 + 基地旁回血 + 泉水倒计时 */
  for (const u of game.units) {
    if (!u.alive) continue;
    if (u.spring > 0 && !springPick.has(u.id)) u.spring--;

    const cap = maxHpAt(game, u.owner, u.x, u.y);
    if (u.hp > cap) u.hp = cap;

    const b = game.bases[u.owner];
    if (b && b.alive && chebyshev(u, b) <= RULES.regenRadius && u.hp < cap) {
      u.hp = Math.min(cap, u.hp + RULES.regenNearBase);
    }
    if (u.hp < 1) u.hp = 1;   // 远离基地不会直接掉死，只会被打死
  }

  /* 12. 生产 */
  for (const ai of AI_IDS) {
    let n = produceRequests[ai];
    if (!n || !factionAlive(game, ai)) continue;
    while (n-- > 0) {
      if (game.stock[ai] < cfg.unitCost) { game.events.push(`${ai} 资源不足`); break; }
      if (aliveCount(game, ai) >= cfg.maxUnits) { game.events.push(`${ai} 已达上限`); break; }
      const spot = findSpawnSpot(game, ai);
      if (!spot) { game.events.push(`${ai} 基地周围无空位`); break; }
      game.stock[ai] -= cfg.unitCost;
      game.nextUnitNo[ai] += 1;
      game.units.push({
        id: `${ai}${String(game.nextUnitNo[ai]).padStart(2, '0')}`,
        owner: ai,
        x: spot.x, y: spot.y,
        hp: maxHpAt(game, ai, spot.x, spot.y),
        spring: 0,
        alive: true,
        bornTurn: turn,
      });
      game.events.push(`${ai} 造兵（-${cfg.unitCost}）`);
    }
  }

  /* 13. 胜负 */
  const survivors = AI_IDS.filter(a => factionAlive(game, a));
  if (survivors.length <= 1) {
    game.over = true;
    game.winner = survivors[0] || rankByTerritory(game)[0];
    game.winType = survivors.length === 1 ? 'conquest' : 'mutual-destruction';
    game.events.push(`全灭！${game.winner} 征服全图`);
  } else if (turn >= game.maxTurns) {
    game.over = true;
    game.winner = rankByTerritory(game)[0];
    game.winType = 'territory';
    game.events.push(`回合耗尽，${game.winner} 领土最多，获胜`);
  }

  game.history.push(historyEntry(game, turn));
  if (game.history.length > 220) game.history.shift();

  game.events = condenseEvents(game.events);
  return game;
}

function findSpawnSpot(game, ai) {
  const b = game.bases[ai];
  if (!b || !b.alive) return null;
  const cands = spawnRing(b).filter(p =>
    inBounds(p.x, p.y) && !isWall(game, p.x, p.y) &&
    !unitAt(game, p.x, p.y) && !resourceAt(game, p.x, p.y)
  );
  return cands[0] || null;
}

function condenseEvents(events) {
  const count = new Map();
  const order = [];
  for (const e of events) {
    if (!count.has(e)) { count.set(e, 0); order.push(e); }
    count.set(e, count.get(e) + 1);
  }
  return order.map(e => (count.get(e) > 1 ? `${e} ×${count.get(e)}` : e));
}

export function rankByTerritory(game) {
  const living = AI_IDS.filter(a => factionAlive(game, a));
  const pool = living.length ? living : AI_IDS;
  return [...pool].sort((a, b) => {
    if (game.territoryCount[b] !== game.territoryCount[a]) return game.territoryCount[b] - game.territoryCount[a];
    const aa = aliveCount(game, a), ab = aliveCount(game, b);
    if (aa !== ab) return ab - aa;
    if (game.scores[b] !== game.scores[a]) return game.scores[b] - game.scores[a];
    return game.kills[b] - game.kills[a];
  });
}

export function displayRanking(game) {
  return [...AI_IDS].sort((a, b) => {
    const av = factionAlive(game, a) ? 1 : 0;
    const bv = factionAlive(game, b) ? 1 : 0;
    if (av !== bv) return bv - av;
    return game.territoryCount[b] - game.territoryCount[a];
  });
}

/* ---------------- 私有视图 ---------------- */

export function getViewFor(game, aiId) {
  const myUnits = game.units.filter(u => u.owner === aiId && u.alive);
  const globalVision = RULES.globalVision !== false;
  const visible = new Set();

  if (!globalVision) {
    for (const u of myUnits) {
      const r = RULES.vision;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) visible.add(`${u.x + dx},${u.y + dy}`);
      }
    }
  }
  const seen = (x, y) => globalVision || visible.has(`${x},${y}`);

  const base = game.bases[aiId];

  // 逐格领土地图：脚本策略靠 territoryAt(game,x,y) 读整张网格，
  // 这里给所有玩家等价的逐格信息（50 行 × 50 字符，第 y 行第 x 字符 = (x,y)）。
  // 局部视野模式下视野外的格子用 ? 遮蔽，与 visibleUnits 的可见性口径一致。
  const mapRows = [];
  for (let y = 1; y <= MAP_H; y++) {
    let row = '';
    for (let x = 1; x <= MAP_W; x++) {
      if (!seen(x, y)) { row += '?'; continue; }
      const c = game.territory[idx(x, y)];
      row += c === WALL_CODE ? '#' : (CODE_OWNER[c] || '.');
    }
    mapRows.push(row);
  }

  return {
    turn: game.turn,
    maxTurns: game.maxTurns,
    over: game.over,
    winner: game.winner,
    you: aiId,
    cfg: game.cfg,
    score: game.scores[aiId],
    kills: game.kills[aiId],
    moveRange: moveRangeOf(game, aiId),
    engageRange: RULES.engageRange,
    autoEngage: RULES.autoEngage,
    fixedHp: RULES.fixedHp,
    gangUpBonus: RULES.gangUpBonus,
    gangUpMaxBonus: RULES.gangUpMaxBonus,
    gangUpBreakAt: RULES.gangUpBreakAt,
    territory: game.territoryCount[aiId],
    totalCells: CELLS,
    stock: game.stock[aiId],
    unitCost: game.cfg.unitCost,
    maxUnits: game.cfg.maxUnits,
    unitsAlive: myUnits.length,
    canProduce: game.stock[aiId] >= game.cfg.unitCost && myUnits.length < game.cfg.maxUnits,
    territoryStandings: AI_IDS
      .map(a => ({
        ai: a, cells: game.territoryCount[a], units: aliveCount(game, a),
        alive: factionAlive(game, a), stock: game.stock[a],
        kills: game.kills[a], harvested: game.scores[a],
      }))
      .sort((a, b) => b.cells - a.cells),
    // 与脚本 buildActions(view, game, ai) 可读的整张网格等价
    territoryMap: mapRows.join('\n'),
    mapRows: MAP_H,
    mapCols: MAP_W,
    mapLegend: 'A/B/C/D=该家领土, .=无主, #=障碍(不可通行/不可占领), ?=视野外；第 y 行第 x 个字符对应坐标 (x,y)',
    wallCount: game.wallCount,
    wallRatio: game.cfg.wallRatio,
    goldMine: {
      x: game.goldMine.x, y: game.goldMine.y,
      owner: game.goldMine.owner,
      yield: game.cfg.goldYield,
      produced: game.goldMine.produced,
    },
    // 上一回合裁判丢弃 / 阻挡的动作数：四家全部公开，纯反馈、不替任何人修正
    lastRejected: game.rejectedByAI || Object.fromEntries(
      AI_IDS.map(a => [a, { invalid: 0, blocked: 0 }])
    ),
    units: myUnits.map(u => ({
      id: u.id, x: u.x, y: u.y, hp: u.hp,
      maxHp: maxHpAt(game, aiId, u.x, u.y),
      attack: attackOf(game, u),
      spring: u.spring,
      distToBase: distToBase(game, aiId, u.x, u.y),
    })),
    visibleUnits: game.units
      .filter(u => u.alive && u.owner !== aiId && seen(u.x, u.y))
      .map(u => ({
        id: u.id, owner: u.owner, x: u.x, y: u.y, hp: u.hp,
        maxHp: maxHpAt(game, u.owner, u.x, u.y),
        attack: attackOf(game, u),
        spring: u.spring,
        distToBase: distToBase(game, u.owner, u.x, u.y),
      })),
    visibleResources: game.resources
      .filter(r => seen(r.x, r.y))
      .map(r => ({ type: r.type, x: r.x, y: r.y, stock: r.stock, claimedBy: r.claimedBy })),
    visionScope: globalVision ? 'global' : 'local',
    bases: AI_IDS.map(a => ({
      owner: a,
      x: game.bases[a].x,
      y: game.bases[a].y,
      alive: game.bases[a].alive,
      hp: game.bases[a].hp,
      maxHp: game.bases[a].maxHp,
    })),
    expandTargets: frontierOf(game, aiId, 12),
    hpAtBase: maxHpAt(game, aiId, base.x, base.y),
    events: game.events,
  };
}

function frontierOf(game, aiId, limit = 12) {
  const code = OWNER_CODE[aiId];
  const seen = new Set();
  const out = [];
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  for (const u of game.units) {
    if (!u.alive || u.owner !== aiId) continue;
    for (const [dx, dy] of DIRS) {
      for (let k = 1; k <= 18; k++) {
        const x = u.x + dx * k, y = u.y + dy * k;
        if (!inBounds(x, y)) break;
        const o = game.territory[idx(x, y)];
        if (o === WALL_CODE) break;        // 撞到障碍就停，不把它当扩张目标
        if (o === code) continue;
        const key = `${x},${y}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ x, y, owner: CODE_OWNER[o] || null });
        }
        break;
      }
    }
    if (out.length >= limit * 3) break;
  }
  return out.slice(0, limit);
}
