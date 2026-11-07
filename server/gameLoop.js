// server/gameLoop.js — 回合驱动：脚本自动对局（测试 / 演示）+ LLM 对局
import {
  createGame, resolveTurn, getViewFor, AI_IDS, displayRanking, aliveCount,
  factionAlive, CELLS, MAP_W, MAP_H, RULES, normalizeCfg, CFG_LIMITS,
} from './engine.js';
import { STRATEGIES } from './bots.js';
import { askLLMDetailed, extractJSON, resolveConfig } from './llm.js';
import { logLLMTrace } from './logger.js';

const TURN_DELAY = Number(process.env.TURN_DELAY_MS || 0);
const DEFAULT_STRATEGIES = ['aggressive', 'economist', 'fortress', 'turtle'];

/** 大模型「自主决策」时不注入任何固定套路 */
export const LLM_STYLE = {
  name: '自主决策',
  style: '没有预设套路：自己读局面，权衡开垦、采矿、造兵、泉水、守家与斩首，选择本回合最优的动作组合。',
};

/** 打法风格 → 提示词人格；auto / 未知都回落到自主决策 */
export function styleFor(strategy) {
  return STRATEGIES[strategy] || LLM_STYLE;
}

function collectActions(assignment, ai, game) {
  const strat = STRATEGIES[assignment[ai]] || STRATEGIES.economist;
  const view = getViewFor(game, ai);
  return strat.buildActions(view, game, ai);
}

const fmtScores = game =>
  displayRanking(game).map(ai => `${ai}:${game.territoryCount[ai]}`).join('  ');

/** 纯脚本对局 */
export async function runAutoGame({ seed = 20261106, cfg = {}, strategies = DEFAULT_STRATEGIES, verbose = false } = {}) {
  const conf = normalizeCfg(cfg);
  const game = createGame(seed, { cfg: conf });
  const assignment = Object.fromEntries(AI_IDS.map((ai, i) => [ai, strategies[i % strategies.length]]));

  while (!game.over) {
    const actionsByAI = {};
    for (const ai of AI_IDS) actionsByAI[ai] = collectActions(assignment, ai, game);
    resolveTurn(game, actionsByAI);
    if (verbose && game.events.length) {
      console.log(`T${String(game.turn).padStart(3, '0')} | ${game.events.join(' | ')} | ${fmtScores(game)}`);
    }
  }
  return { game, assignment };
}

/** LLM 对局（CLI 用）：策略 style 作为提示词，输出 JSON 动作，裁判端二次校验 */
export async function runLLMGame({
  seed = 20261106, cfg = {}, configs = {}, llm = {},
  strategies = DEFAULT_STRATEGIES, onTurn = null, recallFor = null,
} = {}) {
  const conf = normalizeCfg(cfg);
  const game = createGame(seed, { cfg: conf });
  const assignment = Object.fromEntries(AI_IDS.map((ai, i) => [ai, strategies[i % strategies.length]]));
  const llmBase = resolveConfig(llm);

  while (!game.over) {
    const actionsByAI = {};

    await Promise.all(AI_IDS.map(async ai => {
      if (!factionAlive(game, ai)) { actionsByAI[ai] = []; return; }
      const strat = styleFor(assignment[ai]);
      const view = getViewFor(game, ai);
      let raw = '', detail = null, failure = '';
      try {
        const recall = typeof recallFor === 'function' ? recallFor(ai, view) : '';
        detail = await askLLMDetailed(buildPrompt(view, strat, recall), { ...llmBase, ...(configs[ai] || {}) });
        raw = detail.text;
      } catch (e) {
        failure = e.message;
        console.error(`[${ai}] LLM error: ${e.message}`);
      }
      const parsed = extractJSON(raw);
      // 请求失败 / 输出不合法 → 该回合用脚本策略顶上，不让整局卡住
      const acts = parsed
        ? sanitizeActions(parsed.actions, view, ai)
        : STRATEGIES[assignment[ai]]?.buildActions(view, game, ai) || [];
      actionsByAI[ai] = acts;
      // 原始输出、清洗后动作、上回合被拒数一次记全，便于事后逐动作复盘
      logLLMTrace({
        turn: view.turn + 1, ai,
        model: detail?.model || '-', provider: detail?.provider || '', ms: detail?.ms || 0,
        state: failure ? 'error' : (parsed ? 'ok' : 'parse'),
        error: failure || (parsed ? '' : '输出不是合法 JSON，已降级'),
        note: typeof parsed?.note === 'string' ? parsed.note.trim().slice(0, 120) : '',
        thinking: detail?.reasoning || '',
        raw, actions: acts, rejected: view.lastRejected?.[ai], source: 'cli',
      });
    }));

    resolveTurn(game, actionsByAI);
    if (onTurn) onTurn(game, { actionsByAI });
    if (game.events.length) console.log(`T${game.turn} | ${game.events.join(' | ')}`);
    if (TURN_DELAY) await new Promise(r => setTimeout(r, TURN_DELAY));
  }
  return { game, assignment };
}

/** 第三参 recall 是服务端注入的历史记忆块；为空时提示词与旧版完全一致 */
export function buildPrompt(view, strat, recall = '') {
  const cfg = view.cfg;
  const compact = {
    turn: view.turn,
    maxTurns: view.maxTurns,
    you: view.you,
    strategy: strat.name,
    style: strat.style,
    myTerritoryCells: view.territory,
    totalCells: view.totalCells,
    standings: view.territoryStandings,
    // 与脚本策略读到的整张 game.territory 网格等价（50 行 × 50 字符）
    territoryMap: view.territoryMap.split('\n'),
    mapGeometry: `${view.mapRows} 行 × ${view.mapCols} 列；数组第 i 行对应 y=i，行内第 x 个字符对应 x（均从 1 数）`,
    mapLegend: view.mapLegend,
    wallCount: view.wallCount,
    goldMine: view.goldMine,
    lastRejected: view.lastRejected,
    moveRange: view.moveRange,
    engageRange: view.engageRange,
    gangUp: `同一目标每多 1 个同时攻击者，每个攻击者 +${RULES.gangUpBonus} 伤害（上限 +${RULES.gangUpMaxBonus}）；被 ≥${RULES.gangUpBreakAt} 人围攻时 defend 减伤失效`,
    attack: cfg.attack,
    unitHp: cfg.unitHp,
    hpFixed: RULES.fixedHp,
    stock: view.stock,
    unitCost: view.unitCost,
    unitsAlive: view.unitsAlive,
    maxUnits: view.maxUnits,
    canProduce: view.canProduce,
    units: view.units,
    visibleEnemies: view.visibleUnits,
    visibleResources: view.visibleResources,
    expandTargets: view.expandTargets,
    bases: view.bases,
    recentEvents: view.events,
  };

  const memoryBlock = recall
    ? `${recall}\n\n请对照上面的历史反馈调整本回合决策：优先修正反复出现的败因，但一切以当前局面为准。\n`
    : '';

  return `你是《边界殖民地》里的 AI 玩家 ${view.you}，策略是「${strat.name}」：${strat.style}

【最高指令 · 全力求胜】
这一局只有第一名，没有第二名。第 2、3、4 名对你是同一个结果：输。你要用一切可用手段赢下它。

求胜准则（每回合逐条过一遍）：
1. 先算胜势：你现在的领土 / 兵力 / 资源，相对上回合是变强还是变弱？这组动作做完，你会比对手更接近赢吗？答不上来就换动作。
2. 拒绝空转：不许原地待命、不许来回走同一片地、不许把兵堆在无关角落。每个士兵每回合都要有明确收益：开垦新格、站上矿点采集、进入能打到人的位置、或守住基地格。**但开垦和交战不能替代经济**——没有采集就没有资源，没有资源就造不出兵，铺再大的领土也会在后期被逐格翻回去。
3. 资源是弹药，不是存款：够造就立刻造（canProduce=true 时别漏掉 produce），资源在账上躺超过 1 回合就是浪费；采矿是为了更多兵和更快开垦，不是攒数字好看。**四个势力的造兵成本、上限和采集收益完全相同**。
4. 进攻要算收益：能抢下的泉水/要塞、能拆的基地、能成片翻掉的敌境才值得压上。敌对士兵进入 ${RULES.engageRange} 格会自动互相开火、被多人集火还会被瞬间打穿，**孤军冲进敌方兵堆是白送**；推进时让 2–3 个兵互相照应、优先打队友已经在打的目标。
5. 领先就扩大，落后就冒险：领先时压缩对手生存空间、盯着最接近你的那家打；落后时用高风险高回报的动作去搏（偷基地、绕后开垦、强行穿过敌境），落后还打安全牌就是慢性认输。
6. 明确敌我优先级：谁是当前第二名就重点打谁，别把兵力平均分给三家。能一次打崩一家就不要同时惹两家。
7. 算清代价再换血：残血兵不往前送；但该兑子时果断兑——用一个兵换掉对手重要的兵或开垦位，是赚的。
8. 不放弃：哪怕只剩 1 个兵 1 块地，也要去找翻盘点（偷基地、截矿、绕后开垦）。投降和摆烂一律不允许。

你的判断标准只有一个：**这回合结束后，我离赢是不是更近了。** 不要写"稳妥"、"观望"、"保存实力"这类自我安慰的决策。

【信息对称：你和另外三家拿到的是同一份局面】
- \`territoryMap\` 是整张 ${MAP_W}×${MAP_H} 的逐格归属，与脚本对手读到的网格是同一份；\`standings\` 含四家的领土 / 兵力 / 库存 / 击杀 / 采集，\`visibleEnemies\` 含全部敌方单位的血量、攻击与泉水状态。没有任何一方开图。
- 脚本对手每回合都会照同一套规则行动：站矿点就 harvest、库存够就 produce、把兵派去未占或敌方格子开垦；它们不会观望，也不会停。它们不比你多任何信息，也不少任何信息。
- \`lastRejected\` 是上一回合**四家**被裁判丢弃（invalid）或一步没走成（blocked）的动作数，四家口径一致。裁判不会替任何人修正动作，只会把结果如实公开。

当前状态（JSON）：
${JSON.stringify(compact, null, 2)}

${memoryBlock}
只输出一个 JSON 对象，不要解释：
{
  "note": "一句话说明本回合决策依据，可省略",
  "actions": [
    {"unit":"A02","type":"move","path":[[x1,y1],[x2,y2]]},
    {"unit":"A03","type":"attack","target":"B03"},
    {"unit":"A04","type":"harvest"},
    {"unit":"A05","type":"defend"},
    {"type":"produce"}
  ]
}

规则（现行版本，没有结盟，四家永远敌对）：
- 地图 ${MAP_W}×${MAP_H} 格，坐标从 1 开始，(x,y) 的 x 向右、y 向下；逐格归属见 \`territoryMap\`。
- **障碍**：\`territoryMap\` 里的 \`#\` 是不可通行的深灰地形（全图 ${view.wallCount} 格）。**不能走上去、不能被占领、不能布置资源**，
  四家一视同仁。path 里只要出现 \`#\` 格，整条 move 会被裁判判为 invalid 丢弃。绕开它走，也别把它当扩张目标。
- 每个存活士兵给一个 action：move / attack / harvest / defend / wait。
- move：path **首格必须与士兵当前坐标相邻**（切比雪夫距离 1，含斜向），之后每格连续相邻，最多 ${view.moveRange} 步，
  坐标全部在 1..${MAP_W} 范围内，且不能穿过其他士兵或 \`#\` 障碍格。
  **任何一格不合法，整条 move 会被裁判丢弃、该兵原地不动** —— 裁判不会替你截断或纠偏，也不会替脚本纠偏。
  写 path 前先对照 \`units\` 里该兵的 (x,y) 算第一步，别写终点坐标当第一步。
  **士兵走过的每一格，连同周边 8 格，全部重新归你** —— 敌方领土走过即翻旗，开垦靠走。
  驻足不动的士兵每回合也会把脚下 3×3 翻成自己的；击杀在阵亡点 3×3 易主，攻陷基地全部易主。
- 包围结算：中立格四个正交邻格若同属一家，自动归该家；你的一块连通领土若被单一敌家从 8 向完全包住、
  且这块地里**没有任何你自己的士兵**，整块会判给对方。所以领土要留人守，别只靠涂色。
- **交战是自动的**：任意敌方士兵与你相距 ≤ ${RULES.engageRange} 格（切比雪夫距离，含斜向）时，双方每回合自动互相开火，
  伤害 = 攻击力（${cfg.attack}，饮泉水后 +${RULES.springAtk}），固定值、与位置距离无关。**不写 attack 也会打**，所以贴身就是换血，别把残血兵往前送。
- **群殴加成**：同一个目标本回合被 N 个敌方士兵同时攻击时，每个攻击者伤害额外 +（N-1）×${RULES.gangUpBonus}，最多 +${RULES.gangUpMaxBonus}；
  并且被 ≥${RULES.gangUpBreakAt} 人围攻时，它的 defend 减伤直接失效。**集中火力围殴一个目标，比各打各的划算得多** —— 优先打队友已经在打的那个敌人。
- attack：在交战范围内**指定优先目标**（集中火力），伤害同上；不指定就自动打最近的敌人。
- harvest：站在普通矿点格上采集，+${RULES.harvestYield} 资源，矿点储量耗尽即消失。
- produce：花 ${cfg.unitCost} 资源在基地旁造一个士兵（每回合最多 1 个，上限 ${cfg.maxUnits}）。
- defend：原地防守，**本回合不开火**，但受到的伤害减半（被人围殴时减伤失效），并开垦脚下 3×3。

中央黄金矿：
- 固定占 (${view.goldMine.x},${view.goldMine.y}) 这一格，**资源总量无限、永不会枯竭、不会被摧毁**，也不是障碍，四家都能走到。
- 任意一家的士兵**站上这一格即占领**（\`goldMine.owner\` 记录当前持有者），之后**每回合自动 +${cfg.goldYield} 资源**，不需要留兵驻守。
- 但别人把兵踩上去就立刻易主，收入也跟着转过去；持有方一旦亡国，矿变回无主。
- 它和四家的距离都一样，是长期的滚雪球收入；\`goldMine.produced\` 是全局累计产出，\`goldMine.yield\` 是每回合产量。
- 普通矿点靠 harvest 主动采集，黄金矿靠占领被动产出，两者互不影响。

士兵血量（已改为固定）：
- 血量上限固定 ${cfg.unitHp} 点，**走到哪都一样**，不再随离自家基地的距离衰减。
- 想补血就在基地 ${RULES.regenRadius} 格内待着，每回合回 ${RULES.regenNearBase} 点（不超过上限）。
- 也就是说：兵的血量同一套标准，远征和守家没有区别，胜负只看位置、数量与集火。

泉水 / 要塞：
- 泉水：踩上去即获得 +${RULES.springAtk} 攻击，持续 ${RULES.springTurns} 回合。远征前先喝一口。
- 要塞：士兵站上去即归你，之后每回合自动向外开垦 3×3；站在要塞上的士兵受到伤害 -1。

主基地：
- 每家一个基地（坐标公开），耐久 ${cfg.baseHp}。
- 敌方士兵站在你的基地格上，每个每回合削减 ${cfg.siege} 耐久；归零则亡国，全部领土并给攻方。
- 基地格上站着己方士兵时，敌人进不来。至少留一个守家。

胜负（按这个倒推每回合该干什么）：
- 提前赢：把任何一家的基地耐久打到 0 → 该家亡国、全部领土并给攻方；只剩你一家基地即征服胜利。这是唯一能提前终结比赛的路。
- 打满 ${view.maxTurns} 回合：领土格数最多者胜，同分依次比 士兵数 → 采集量 → 击杀数。
- 因此：领土第一必须守住；领土不是第一，就必须去抢地或让对手掉地，光攒兵换不来胜点。

输出前自检（默念一遍，不满足就改动作）：这回合我的领土增加了吗？有兵在矿点采集吗？黄金矿现在归谁、要不要去踩？canProduce 为真时写 produce 了吗？每条 path 的首格都与士兵当前坐标相邻、逐格连续、坐标都在 1..${MAP_W}、**没有踩到 \`#\` 障碍格**吗？有没有士兵白站一回合？有没有孤军送进敌方 2 格交战圈？\`lastRejected\` 里我上回合的 invalid 是多少、这回合改掉了吗？`;
}

export function sanitizeActions(actions, view, ai) {
  const owned = new Set(view.units.map(u => u.id));
  const enemies = new Set(view.visibleUnits.map(u => u.id));
  const list = Array.isArray(actions) ? actions : [];
  const out = [];
  const seen = new Set();
  let produceAsked = false;

  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'produce') {
      if (!produceAsked && view.canProduce) { out.push({ type: 'produce' }); produceAsked = true; }
      continue;
    }
    if (!owned.has(a.unit) || seen.has(a.unit)) continue;
    seen.add(a.unit);

    if (a.type === 'attack' && enemies.has(a.target)) {
      out.push({ unit: a.unit, type: 'attack', target: a.target });
    } else if (a.type === 'move' && Array.isArray(a.path) && a.path.length) {
      const path = a.path
        .filter(p => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]))
        .slice(0, view.moveRange);
      out.push(path.length ? { unit: a.unit, type: 'move', path } : { unit: a.unit, type: 'wait' });
    } else if (['harvest', 'defend', 'wait'].includes(a.type)) {
      out.push({ unit: a.unit, type: a.type });
    } else {
      out.push({ unit: a.unit, type: 'wait' });
    }
  }
  for (const id of owned) if (!seen.has(id)) out.push({ unit: id, type: 'wait' });
  return out;
}

/* ---------------- CLI ---------------- */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/gameLoop.js');
if (isMain && process.argv.includes('--auto')) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const strategies = argOf('--strategies', DEFAULT_STRATEGIES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const seed = Number(argOf('--seed', 20261106));
  const cfg = {};
  for (const k of Object.keys(CFG_LIMITS)) {
    const v = argOf(`--${k}`, null);
    if (v !== null) cfg[k] = Number(v);
  }

  const t0 = Date.now();
  runAutoGame({ seed, cfg, strategies })
    .then(({ game }) => {
      console.log('\n================ 结算 ================');
      console.log(`seed=${seed}  回合=${game.turn}/${game.maxTurns}  耗时=${Date.now() - t0}ms`);
      for (const ai of displayRanking(game)) {
        const pct = (game.territoryCount[ai] / CELLS * 100).toFixed(1);
        const alive = factionAlive(game, ai) ? `单位 ${String(aliveCount(game, ai)).padStart(2)}/${game.cfg.maxUnits}` : '已亡国';
        console.log(`  ${ai}  领土 ${String(game.territoryCount[ai]).padStart(5)} (${pct.padStart(5)}%)  ${alive.padEnd(12)}  库存 ${String(game.stock[ai]).padStart(3)}  击杀 ${game.kills[ai]}  采集 ${game.scores[ai]}`);
      }
      console.log(`胜者: ${game.winner}  方式: ${game.winType}`);
    })
    .catch(e => { console.error('对局失败:', e); process.exit(1); });
}
