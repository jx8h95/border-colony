// test/rules.mjs — v6.1 规则单测
import assert from 'assert';
import {
  createGame, resolveTurn, getViewFor, AI_IDS, idx, CELLS, MAP_W, MAP_H,
  maxHpAt, attackOf, territoryAt, OWNER_CODE, CODE_OWNER, RULES,
  normalizeCfg, CFG_LIMITS, applyEncirclement, paint,
  isWall, WALL_CODE, GOLD_POS, inBounds,
} from '../server/engine.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const cellAt = (g, x, y) => g.territory[idx(x, y)];

/** 清空棋盘，用于直接测试包围判定 */
function board(g) {
  g.territory.fill(0);
  g.territoryCount = { A: 0, B: 0, C: 0, D: 0 };
  g.territoryGain = { A: 0, B: 0, C: 0, D: 0 };
  g.units = [];
  g.events = [];
}
function setOwner(g, x, y, owner) {
  const i = idx(x, y);
  const prev = g.territory[i];
  if (prev) g.territoryCount[CODE_OWNER[prev]]--;
  g.territory[i] = owner ? OWNER_CODE[owner] : 0;
  if (owner) g.territoryCount[owner]++;
}
function ringB(g, cx, cy) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) setOwner(g, cx + dx, cy + dy, 'B');
    }
  }
}

/* 1. 坐标与领土编码一致 */
test('idx() 与地图坐标一一对应', () => {
  assert.equal(idx(1, 1), 0);
  assert.equal(idx(MAP_W, 1), MAP_W - 1);
  assert.equal(idx(1, 2), MAP_W);
  assert.equal(idx(MAP_W, 50), CELLS - 1);
});

/* 2. 士兵走过的格子 + 周边 8 格归己方 */
test('移动开垦：每步 3×3 归己方', () => {
  const g = createGame(7, { cfg: { mines: 8, springs: 2, fortresses: 2 } });
  const u = g.units.find(x => x.owner === 'A');
  const target = { x: 20, y: 20 };
  g.turn = 0;
  resolveTurn(g, { A: [{ unit: u.id, type: 'move', path: [[u.x + 1, u.y]] }] });

  // 走到的格子自己 + 周边 8 格
  assert.equal(territoryAt(g, u.x, u.y), 'A');
  assert.equal(territoryAt(g, u.x + 1, u.y + 1), 'A');
  assert.equal(territoryAt(g, u.x - 1, u.y - 1), 'A');
});

/* 3. v6.1：走过已占领的领土（含敌方）会重新占领 */
test('移动会重新占领敌方领土', () => {
  const g = createGame(8, { cfg: { mines: 8, springs: 2, fortresses: 2 } });
  const u = g.units.find(x => x.owner === 'A');
  const bx = u.x + 1, by = u.y;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) setOwner(g, bx + dx, by + dy, 'B');
  }
  assert.equal(territoryAt(g, bx, by), 'B');
  resolveTurn(g, { A: [{ unit: u.id, type: 'move', path: [[bx, by]] }] });
  assert.equal(territoryAt(g, bx, by), 'A', '走过的敌方领土应翻旗');
  assert.equal(territoryAt(g, bx + 1, by + 1), 'A', '周边 8 格一并翻旗');
});

test('驻足的士兵也会翻掉脚下的敌方领土', () => {
  const g = createGame(81, { cfg: { mines: 8, springs: 2, fortresses: 2 } });
  const u = g.units.find(x => x.owner === 'A');
  u.x = 25; u.y = 25;
  for (const other of g.units) if (other !== u) { other.x = 1; other.y = 1; }
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) setOwner(g, 25 + dx, 25 + dy, 'B');
  }
  resolveTurn(g, { A: [{ unit: u.id, type: 'defend' }] });
  assert.equal(territoryAt(g, 25, 25), 'A');
  assert.equal(territoryAt(g, 26, 26), 'A');
});

/* 4. v6.6：血量固定，不再随离基地距离衰减 */
test('血量上限固定，与离基地距离无关', () => {
  const g = createGame(9, { cfg: { unitHp: 20, hpDecay: 4 } });
  const b = g.bases.A;
  assert.equal(RULES.fixedHp, true);
  assert.equal(maxHpAt(g, 'A', b.x, b.y), 20, '基地格满血');
  assert.equal(maxHpAt(g, 'A', b.x + 10, b.y), 20, '10 格外仍满血');
  assert.equal(maxHpAt(g, 'A', b.x + 30, b.y), 20, '30 格外仍满血');

  // 关掉开关后旧衰减规则可恢复（可逆）
  RULES.fixedHp = false;
  try {
    assert.equal(maxHpAt(g, 'A', b.x + 10, b.y), 12, '10 格 → -40%');
    assert.equal(maxHpAt(g, 'A', b.x + 30, b.y), 5, '极远压到 25% 地板');
  } finally {
    RULES.fixedHp = true;
  }
});

/* 5. 走到远处也不再被压血 */
test('远离基地不掉血', () => {
  const g = createGame(10, { cfg: { unitHp: 20, hpDecay: 5, moveRange: 8 } });
  const u = g.units.find(x => x.owner === 'A');
  assert.equal(u.hp, 20);
  u.x = g.bases.A.x + 25;
  u.y = g.bases.A.y;
  resolveTurn(g, { A: [{ unit: u.id, type: 'defend' }] });
  assert.equal(u.hp, 20, '固定血量下远征不掉血');
});

/* 6. 泉水：踩上去攻击 +3，持续 4 回合 */
test('泉水提供攻击加成', () => {
  const g = createGame(11, { cfg: { attack: 2, springs: 6, hpDecay: 0 } });
  g.resources = g.resources.filter(r => r.type === 'spring').slice(0, 1);
  const u = g.units.find(x => x.owner === 'A');
  u.x = 25; u.y = 25;
  for (const x of g.units) if (x !== u && x.x === 26 && x.y === 25) { x.x = 1; x.y = 1; }
  g.resources[0].x = 26;
  g.resources[0].y = 25;

  resolveTurn(g, { A: [{ unit: u.id, type: 'move', path: [[26, 25]] }] });
  assert.equal(u.spring, RULES.springTurns);
  assert.equal(attackOf(g, u), 2 + RULES.springAtk);

  u.x = 20; u.y = 20;                        // 离开泉水，加成才开始倒计时
  for (let i = 0; i < RULES.springTurns - 1; i++) {
    resolveTurn(g, { A: [{ unit: u.id, type: 'defend' }] });
  }
  assert.equal(attackOf(g, u), 2 + RULES.springAtk, `第 ${RULES.springTurns} 回合仍有效`);

  resolveTurn(g, { A: [{ unit: u.id, type: 'defend' }] });
  assert.equal(u.spring, 0);
  assert.equal(attackOf(g, u), 2);
});

/* 7. 战斗：相交即互相扣血，击杀者夺取 3×3
   v6.5 起交战是双向的（距离 ≤ engageRange 自动互射），所以攻击方血量要够活下来 */
test('交战扣血，击杀者夺取 3×3', () => {
  const g = createGame(12, { cfg: { attack: 5, unitHp: 10 } });
  const a = g.units.find(x => x.owner === 'A');
  const b = g.units.find(x => x.owner === 'B');
  b.x = a.x + 1; b.y = a.y;
  b.hp = 3;
  const hp0 = b.hp;
  resolveTurn(g, { A: [{ unit: a.id, type: 'attack', target: b.id }] });
  assert.equal(b.alive, false, '3 血被 5 攻打应阵亡');
  assert.equal(g.kills.A, 1);
  assert.equal(a.alive, true, '攻击方有 10 血，换掉 5 点后应存活');
  assert.equal(territoryAt(g, a.x, a.y), 'A');
  assert.ok(hp0 > 0);
});

/* 7b. v6.5：交战距离 = 2 格，且不需要声明 attack */
test('距离 2 格自动交火，3 格不交火', () => {
  const battle = (d, actionsOf = null) => {
    const g = createGame(21, { cfg: { attack: 3, unitHp: 10, hpDecay: 0 } });
    g.units = g.units.filter(u => u.owner === 'A' || u.owner === 'B');
    const a = g.units.find(u => u.owner === 'A');
    const b = g.units.find(u => u.owner === 'B');
    a.x = 20; a.y = 20; b.x = 20 + d; b.y = 20;
    resolveTurn(g, actionsOf ? actionsOf(b) : {});
    return { a, b, g };
  };

  const near2 = battle(2);
  assert.equal(near2.a.hp, 7, '距离 2 应吃到 3 点伤害');
  assert.equal(near2.b.hp, 7, '距离 2 应吃到 3 点伤害（双向）');

  const near3 = battle(3);
  assert.equal(near3.a.hp, 10, '距离 3 不该交火');
  assert.equal(near3.b.hp, 10, '距离 3 不该交火');

  // 固守方只挨打、不开火，伤害减半
  const def = battle(1, b => ({ B: [{ unit: b.id, type: 'defend' }] }));
  assert.equal(def.a.hp, 10, '固守的 B 不开火，A 不掉血');
  assert.equal(def.b.hp, 8, '固守方伤害减半（3 → 2）');
});

/* 7c. v6.6 群殴：多人同时打一个目标 → 每人伤害递增，且破掉 defend 减伤 */
test('群殴加成与破防', () => {
  const setup = (nA, defTarget = false) => {
    const g = createGame(31, { cfg: { attack: 3, unitHp: 30 } });
    const a = g.units.filter(u => u.owner === 'A').slice(0, nA);
    const b = g.units.filter(u => u.owner === 'B')[0];
    g.units = [...a, b];
    b.x = 25; b.y = 25;
    [[24, 25], [26, 25], [25, 26]].slice(0, nA).forEach(([x, y], i) => {
      a[i].x = x; a[i].y = y;
    });
    const acts = defTarget ? { B: [{ unit: b.id, type: 'defend' }] } : {};
    resolveTurn(g, acts);
    return { a, b };
  };

  // 1 打 1：无加成，各吃 3
  const solo = setup(1);
  assert.equal(solo.b.hp, 27, '单挑伤害 3');

  // 2 打 1：每个攻击者 3 + 1 = 4，共 8
  const duo = setup(2);
  assert.equal(duo.b.hp, 22, '2 打 1 每人 +1（共 8）');

  // 3 打 1：每个攻击者 3 + 2 = 5，共 15
  const trio = setup(3);
  assert.equal(trio.b.hp, 15, '3 打 1 每人 +2（共 15）');

  // 被 2 人围殴时 defend 减伤失效：4 + 4 = 8（若不破防应为 2 + 2 = 4）
  const gangDef = setup(2, true);
  assert.equal(gangDef.b.hp, 22, '被围殴时 defend 不再减伤');

  // 单挑时 defend 仍然减半
  const soloDef = setup(1, true);
  assert.equal(soloDef.b.hp, 28, '单挑 defend 仍减半（3 → 2）');
});

/* 8. 生产：扣资源、受上限约束 */
test('生产消耗资源并受上限约束', () => {
  const g = createGame(13, { cfg: { unitCost: 5, maxUnits: 7, unitsPerAI: 6 } });
  const before = g.stock.A;
  resolveTurn(g, { A: [{ type: 'produce' }] });
  assert.equal(g.stock.A, before - 5);
  const n = g.units.filter(u => u.owner === 'A' && u.alive).length;
  assert.equal(n, 7);
  // 已到上限，再造失败
  g.stock.A = 100;
  resolveTurn(g, { A: [{ type: 'produce' }] });
  assert.equal(g.units.filter(u => u.owner === 'A' && u.alive).length, 7);
});

/* 9. 基地被围攻 → 亡国 → 领土易主 */
test('攻陷基地后亡国、领土整体易主', () => {
  const g = createGame(14, { cfg: { baseHp: 10, siege: 10, attack: 1 } });
  // 清掉 B 的守军，把 A 的士兵搬到 B 基地上
  for (const u of g.units) if (u.owner === 'B') u.alive = false;
  const a = g.units.find(x => x.owner === 'A');
  a.x = g.bases.B.x; a.y = g.bases.B.y;
  const bCells = g.territoryCount.B;
  resolveTurn(g, { A: [{ unit: a.id, type: 'defend' }] });
  assert.equal(g.bases.B.alive, false);
  assert.equal(g.territoryCount.B, 0);
  assert.ok(g.territoryCount.A >= bCells);
});

/* 10. 参数上下限 */
test('参数越界自动收敛', () => {
  const cfg = normalizeCfg({ unitsPerAI: 999, maxUnits: 1, hpDecay: -5, turns: 5, attack: 0 });
  assert.equal(cfg.unitsPerAI, CFG_LIMITS.unitsPerAI[1]);
  assert.equal(cfg.maxUnits, cfg.unitsPerAI, '上限不能小于初始值');
  assert.equal(cfg.hpDecay, 0);
  assert.equal(cfg.turns, 10);
  assert.equal(cfg.attack, 1);
});

/* 11. 同 seed 可复盘 */
test('同 seed 同结果', () => {
  const run = () => {
    const g = createGame(555, { cfg: { turns: 20 } });
    for (let i = 0; i < 5; i++) resolveTurn(g, {});
    return JSON.stringify(g.territoryCount);
  };
  assert.equal(run(), run());
});

/* 12 ~ 16. v6.1 包围判定 */
test('中立地四个正交邻格同属一家 → 自动归该家', () => {
  const g = createGame(21, { cfg: {} });
  board(g);
  for (const [x, y] of [[10, 9], [9, 10], [11, 10], [10, 11]]) setOwner(g, x, y, 'B');
  applyEncirclement(g);
  assert.equal(territoryAt(g, 10, 10), 'B');
  assert.equal(g.territoryCount.B, 5);
});

test('四邻分属两家 → 中立地保持中立', () => {
  const g = createGame(22, { cfg: {} });
  board(g);
  setOwner(g, 10, 9, 'B'); setOwner(g, 9, 10, 'B');
  setOwner(g, 11, 10, 'B'); setOwner(g, 10, 11, 'A');
  applyEncirclement(g);
  assert.equal(territoryAt(g, 10, 10), null);
});

test('地图边界不算围墙', () => {
  const g = createGame(23, { cfg: {} });
  board(g);
  setOwner(g, 1, 9, 'B'); setOwner(g, 1, 11, 'B'); setOwner(g, 2, 10, 'B');
  applyEncirclement(g);
  assert.equal(territoryAt(g, 1, 10), null, '贴边格不该被当作被围');
});

test('被单一敌家包围、块内无守军 → 整块易主', () => {
  const g = createGame(24, { cfg: {} });
  board(g);
  for (let y = 8; y <= 12; y++) for (let x = 8; x <= 12; x++) setOwner(g, x, y, 'B');
  // 中间挖一个 2 格宽的 A 孤岛
  setOwner(g, 10, 10, 'A'); setOwner(g, 11, 10, 'A');
  applyEncirclement(g);
  assert.equal(territoryAt(g, 10, 10), 'B');
  assert.equal(territoryAt(g, 11, 10), 'B');
  assert.equal(g.territoryCount.A, 0);
});

test('包围块里有己方士兵 → 守住不失地', () => {
  const g = createGame(25, { cfg: {} });
  board(g);
  ringB(g, 20, 20);
  setOwner(g, 20, 20, 'A');
  g.units.push({ id: 'A99', owner: 'A', x: 20, y: 20, alive: true, hp: 5, spring: 0 });
  applyEncirclement(g);
  assert.equal(territoryAt(g, 20, 20), 'A');
});

test('两家混合包围 → 不易主', () => {
  const g = createGame(26, { cfg: {} });
  board(g);
  ringB(g, 20, 20);
  setOwner(g, 21, 20, 'C');
  setOwner(g, 20, 20, 'A');
  applyEncirclement(g);
  assert.equal(territoryAt(g, 20, 20), 'A');
});

/* 17. 取消结盟 */
test('结盟彻底移除，四家永远敌对', () => {
  const g = createGame(27, { cfg: { attack: 5, unitHp: 5 } });
  assert.equal(g.alliances, undefined);
  assert.equal(g.proposals, undefined);
  const a = g.units.find(x => x.owner === 'A');
  const b = g.units.find(x => x.owner === 'B');
  b.x = a.x + 1; b.y = a.y; b.hp = 3;
  // 即使塞进旧版的外交操作，也不应产生任何效果
  resolveTurn(g, { A: [{ unit: a.id, type: 'attack', target: b.id }] },
    [{ type: 'propose', from: 'A', to: 'B' }, { type: 'accept', from: 'B', to: 'A' }]);
  assert.equal(b.alive, false, '任意两家之间都能互相攻击');
  assert.equal(g.alliances, undefined);
  assert.equal(g.proposals, undefined);
});

/* 18. 逐回合参数快照 */
test('history 含 T0 基线且每回合记录士兵/资源/击杀', () => {
  const g = createGame(28, { cfg: { turns: 10 } });
  assert.equal(g.history.length, 1);
  assert.equal(g.history[0].turn, 0);
  assert.deepEqual(g.history[0].units, { A: 6, B: 6, C: 6, D: 6 });
  resolveTurn(g, {});
  const h = g.history[g.history.length - 1];
  assert.equal(h.turn, 1);
  for (const k of ['territory', 'units', 'stock', 'kills', 'scores', 'gain', 'events']) {
    assert.ok(k in h, `history 缺少 ${k}`);
  }
  assert.equal(typeof h.units.A, 'number');
  assert.equal(typeof h.stock.A, 'number');
});

/* 19. P0：裁判层按单位去重（外部 LLM 可能重复下发同一兵的动作） */
test('同一单位一回合只认第一个动作，重复 move 不会双倍位移', () => {
  const g = createGame(31, { cfg: {} });
  board(g);
  const u = { id: 'A99', owner: 'A', x: 20, y: 20, alive: true, hp: 5, spring: 0 };
  g.units.push(u);
  resolveTurn(g, { A: [
    { unit: u.id, type: 'move', path: [[21, 20], [22, 20], [23, 20]] },
    { unit: u.id, type: 'move', path: [[24, 20], [25, 20], [26, 20]] },
  ] });
  assert.equal(u.x, 23, '第二条 move 应被裁判丢弃');
});

/* 20. P0：攻击结算复核距离 */
test('目标同回合跑远后，收集阶段的攻击不再结算', () => {
  const g = createGame(32, { cfg: {} });
  board(g);
  const a = { id: 'A99', owner: 'A', x: 20, y: 20, alive: true, hp: 5, spring: 0 };
  const b = { id: 'B99', owner: 'B', x: 21, y: 20, alive: true, hp: 1, spring: 0 };
  g.units.push(a, b);
  resolveTurn(g, {
    A: [{ unit: a.id, type: 'attack', target: b.id }],
    B: [{ unit: b.id, type: 'move', path: [[22, 20], [23, 20], [24, 20]] }],
  });
  assert.equal(b.alive, true, 'B 已跑远，不该再挨打');
  assert.equal(b.hp, 1);
});

/* 21. P0：围攻两阶段，互围不再让先手必输 */
test('互围同回合结算：A 与 B 一起亡国，不受 AI_IDS 顺序影响', () => {
  const g = createGame(33, { cfg: {} });
  board(g);
  g.bases.A.hp = 1;
  g.bases.B.hp = 1;
  g.units.push(
    { id: 'B99', owner: 'B', x: g.bases.A.x, y: g.bases.A.y, alive: true, hp: 5, spring: 0 },
    { id: 'A99', owner: 'A', x: g.bases.B.x, y: g.bases.B.y, alive: true, hp: 5, spring: 0 },
  );
  resolveTurn(g, {});
  assert.equal(g.bases.A.alive, false, 'A 应亡国');
  assert.equal(g.bases.B.alive, false, 'B 的围攻者不该因 A 先结算而消失');
});

/* 22. 信息对齐：脚本读 game.territory，LLM 读 territoryMap，两者必须逐格相同 */
test('逐格领土地图与 territoryAt 完全一致，四家拿到同一份', () => {
  const g = createGame(44, { cfg: {} });
  resolveTurn(g, {});
  const a = getViewFor(g, 'A');
  const rows = a.territoryMap.split('\n');
  assert.equal(rows.length, MAP_H);
  for (let y = 1; y <= MAP_H; y++) {
    assert.equal(rows[y - 1].length, MAP_W);
    for (let x = 1; x <= MAP_W; x++) {
      const expected = isWall(g, x, y) ? '#' : (territoryAt(g, x, y) || '.');
      assert.equal(rows[y - 1][x - 1], expected, `(${x},${y}) 归属不一致`);
    }
  }
  for (const ai of AI_IDS.slice(1)) {
    assert.equal(getViewFor(g, ai).territoryMap, a.territoryMap, `${ai} 应拿到同一份网格`);
  }
  assert.ok(a.visibleUnits.every(u => typeof u.maxHp === 'number' && typeof u.attack === 'number'),
    '敌方单位字段应与己方对齐');
  assert.ok(a.territoryStandings.every(s => typeof s.stock === 'number' && typeof s.kills === 'number'),
    '积分榜应含脚本可读的库存/击杀/采集');
});

/* 23. 裁判对称校验：不替任何人纠偏，只丢弃 + 如实计数 */
test('非法 path 整条丢弃并对称计数，合法 path 正常执行', () => {
  const g = createGame(45, { cfg: {} });
  const u = g.units.find(x => x.owner === 'A');
  const x0 = u.x, y0 = u.y;
  resolveTurn(g, { A: [
    { unit: u.id, type: 'move', path: [[x0 + 2, y0]] },  // 首步跳 2 格
    { unit: 'B01', type: 'move', path: [[99, 99]] },      // 越权单位 + 越界
    { type: 'unknown' },                                   // 未知动作
  ] });
  assert.equal(u.x, x0, '非法 path 不该让单位移动');
  assert.equal(u.y, y0);
  assert.equal(g.rejectedByAI.A.invalid, 3);
  assert.equal(g.rejectedByAI.A.blocked, 0);
  assert.equal(g.rejectedByAI.B.invalid, 0, '不该把 A 的错误算到 B 头上');
  const v = getViewFor(g, 'A');
  assert.deepEqual(v.lastRejected.A, { invalid: 3, blocked: 0 }, '下一回合应回灌给所有玩家');
  assert.equal(v.lastRejected.B.invalid, 0);

  const x1 = u.x, y1 = u.y;
  const step = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dy]) => ({ x: x1 + dx, y: y1 + dy }))
    .find(p => p.x >= 1 && p.x <= MAP_W && p.y >= 1 && p.y <= MAP_H &&
               !g.units.some(o => o.alive && o.x === p.x && o.y === p.y));
  assert.ok(step, '应能找到一个无阻挡的相邻格');
  resolveTurn(g, { A: [{ unit: u.id, type: 'move', path: [[step.x, step.y]] }] });
  assert.equal(u.x, step.x, '合法 path 应正常走');
  assert.equal(u.y, step.y);
  assert.equal(g.rejectedByAI.A.invalid, 0, '新回合计数应重置');
});

test('动作合法但被占位挡住一步没走 → blocked 单独计数', () => {
  const g = createGame(46, { cfg: {} });
  const [a1, a2] = g.units.filter(u => u.owner === 'A');
  const p = { x: a1.x + 1, y: a1.y };
  a2.x = p.x; a2.y = p.y;
  const x0 = a1.x, y0 = a1.y;
  resolveTurn(g, { A: [{ unit: a1.id, type: 'move', path: [[p.x, p.y]] }] });
  assert.equal(a1.x, x0);
  assert.equal(a1.y, y0);
  assert.equal(g.rejectedByAI.A.invalid, 0, '路径本身合法，不算 invalid');
  assert.equal(g.rejectedByAI.A.blocked, 1);
});

/* 15. 障碍地形 */
test('障碍：默认 8%、硬上限 10%、可关闭、同 seed 可复现', () => {
  const g = createGame(20261106);
  const limit = Math.floor(CELLS * RULES.wallMaxRatio / 100);
  assert.ok(g.wallCount > 0, '默认应生成障碍');
  assert.ok(g.wallCount <= limit, `不得超过 ${RULES.wallMaxRatio}%`);
  assert.equal((getViewFor(g, 'A').territoryMap.match(/#/g) || []).length, g.wallCount,
    '视图里的 # 数量应等于实际障碍数');
  assert.equal(createGame(20261106).territory.join(','), g.territory.join(','), '同 seed 同地图');
  assert.equal(createGame(20261106, { cfg: { wallRatio: 0 } }).wallCount, 0, '占比可调到 0');
  const max = createGame(20261106, { cfg: { wallRatio: 99 } });
  assert.ok(max.wallCount <= limit, '参数越界也必须被 10% 上限压住');
});

test('障碍不可通行、不可占领、不可布置资源，四家仍可走到中央', () => {
  const g = createGame(20261106);
  assert.ok(g.resources.every(r => !isWall(g, r.x, r.y)), '资源不能在墙上');
  assert.ok(AI_IDS.every(a => !isWall(g, g.bases[a].x, g.bases[a].y)), '基地不能在墙上');
  assert.ok(g.units.every(u => !isWall(g, u.x, u.y)), '初始士兵不能在墙上');
  assert.ok(!isWall(g, GOLD_POS.x, GOLD_POS.y), '中央黄金矿不能被墙盖住');
  assert.ok(!g.resources.some(r => r.x === GOLD_POS.x && r.y === GOLD_POS.y), '黄金矿独占 1 格');

  // 找一格墙 + 它旁边一个非墙格
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let wx = 0, wy = 0, sx = 0, sy = 0;
  for (let i = 0; i < CELLS && !wx; i++) {
    if (g.territory[i] !== WALL_CODE) continue;
    const x = i % MAP_W + 1, y = Math.floor(i / MAP_W) + 1;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(nx, ny) && !isWall(g, nx, ny)) {
        wx = x; wy = y; sx = nx; sy = ny; break;
      }
    }
  }
  assert.ok(wx, '应能找到一格带空邻居的障碍');
  paint(g, 'A', wx, wy, 0);
  assert.equal(g.territory[idx(wx, wy)], WALL_CODE, '障碍永不可占领');
  assert.equal(territoryAt(g, wx, wy), null);

  const h = createGame(20261106);
  const u = h.units.find(x => x.owner === 'A');
  h.units = [u];
  u.x = sx; u.y = sy;
  resolveTurn(h, { A: [{ unit: u.id, type: 'move', path: [[wx, wy]] }] });
  assert.equal(u.x, sx, '踩墙的动作应被整条丢弃');
  assert.equal(u.y, sy);
  assert.equal(h.rejectedByAI.A.invalid, 1, '且计入对称反馈');

  // 8 向连通性：四家基地都能走到中央
  const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const seen = new Uint8Array(CELLS);
  const q = [idx(GOLD_POS.x, GOLD_POS.y)];
  seen[q[0]] = 1;
  for (let head = 0; head < q.length; head++) {
    const i = q[head], x = i % MAP_W + 1, y = Math.floor(i / MAP_W) + 1;
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!seen[ni] && !isWall(g, nx, ny)) { seen[ni] = 1; q.push(ni); }
    }
  }
  assert.ok(AI_IDS.every(a => seen[idx(g.bases[a].x, g.bases[a].y)]), '不能有哪家被墙封死');
});

/* 16. 中央黄金矿 */
test('黄金矿：站上去占领、每回合持续产出、可被夺走、亡国归无主', () => {
  const g = createGame(20261106, { cfg: { goldYield: 2 } });
  assert.equal(g.goldMine.x, GOLD_POS.x);
  assert.equal(g.goldMine.y, GOLD_POS.y);
  assert.equal(g.goldMine.owner, null);

  const a = g.units.find(u => u.owner === 'A');
  const b = g.units.find(u => u.owner === 'B');
  a.x = GOLD_POS.x; a.y = GOLD_POS.y;
  const s0 = g.stock.A;
  resolveTurn(g, {});
  assert.equal(g.goldMine.owner, 'A', '站上去即占领');
  assert.equal(g.stock.A, s0 + 2, '占领当回合就有收入');
  resolveTurn(g, {});
  assert.equal(g.stock.A, s0 + 4, '持有期间每回合都产，无需留守动作');
  assert.equal(g.goldMine.produced, 4);

  a.x = 10; a.y = 10;
  b.x = GOLD_POS.x; b.y = GOLD_POS.y;
  const sB = g.stock.B, sA = g.stock.A;
  resolveTurn(g, {});
  assert.equal(g.goldMine.owner, 'B', '别家踩上来立刻易主');
  assert.equal(g.stock.B, sB + 2);
  assert.equal(g.stock.A, sA, '失去矿后不再有收入');

  g.bases.B.alive = false;
  resolveTurn(g, {});
  assert.equal(g.goldMine.owner, null, '持有方亡国后矿归无主');
});

test('黄金矿产出可调为 0，且不影响普通矿点采集', () => {
  const g = createGame(20261106, { cfg: { goldYield: 0 } });
  const a = g.units.find(u => u.owner === 'A');
  a.x = GOLD_POS.x; a.y = GOLD_POS.y;
  const s0 = g.stock.A;
  resolveTurn(g, {});
  assert.equal(g.goldMine.owner, 'A', '产出为 0 时仍可占领');
  assert.equal(g.stock.A, s0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
