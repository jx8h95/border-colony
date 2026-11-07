# 边界殖民地 v6.8 · AI 接入协议

> 面向「由 LLM 或其他程序操作的玩家」。本文只描述**通信契约**：每个节点服务端给什么、期望你回什么、回错了会怎样。
> 实现参考 `server/llm.js`（模型接入）、`server/profiles.js`（多模型配置）、`server/memory.js`（对局记忆）、`server/gameLoop.js`（`buildPrompt` / `sanitizeActions`）、`server/index.js`（回合驱动）与 `server/engine.js`（裁判）。
>
> **v6.2 起，网页左栏可直接填 API Key 让任意势力改由大模型操控**；**v6.3 起可保存多份 Key，四家各选不同模型**；**v6.4 起模型能拿到局内 / 跨局 / 经验三层记忆**；**v6.7 起四家信息完全对齐（逐格地图等），裁判校验与丢弃反馈对称**；**v6.8 起地图带连续障碍与中央无限黄金矿**。运行时 HTTP 配置接口见第 8 节，记忆闭环见第 9 节。

---

## 0. 一句话规则

4 家势力抢一块 50×50 的棋盘，图上有连续成片的深灰**障碍**（默认 8%、上限 10%，不可通行 / 不可占领 / 不可布置资源），正中央有 1 格**无限黄金矿**（站上去即占领，持有者每回合被动得资源，可被别人踩走）。**士兵走过的格子连周边 8 格一起重新归你（敌方领土也照翻）**；士兵血量固定 10 点、伤害固定为攻击力；敌对士兵进入 2 格内自动交战，多人围殴同一目标会加伤并破防；踩过泉水攻击力提升；拆掉别人基地耐久就能吞并它全部领土。回合结束时领土最多者胜。

**v6.1 的三处变化**

| 变化 | 说明 |
|---|---|
| 取消结盟 | `alliances` / `proposals` / `allianceOps` 全部删除，四家永远敌对，任意两家可互相攻击 |
| 走过即翻旗 | 移动与驻足的 3×3 开垦不再只吃中立地，会直接改写敌方领土归属 |
| 包围易主 | ① 中立格四个正交邻格同属一家 → 归该家；② 己方连通块被单一敌家 8 向完全包住、且块内没有己方士兵 → 整块判给对方 |

**v6.2 的新增（不改规则，只改接入方式）**

| 变化 | 说明 |
|---|---|
| 零 SDK 模型接入 | `server/llm.js` 用原生 `fetch` 直连 OpenAI 兼容端点 / Anthropic 原生端点，7 个服务商预设，只需一个 API Key |
| 每势力独立操控 | 开局前任选「AI 大模型」或「自动策略」+ 打法风格；同一局里可 1 家模型打 3 家脚本 |
| 自动降级 | 未配 Key、超时、HTTP 错误、输出非 JSON → 该势力本回合改跑脚本，回合照常推进 |
| 排行榜 | 右侧实时名次（含名次变化、操控方式、模型状态）与本机会话历史战绩 |

**v6.3 的新增（同样不改规则）**

| 变化 | 说明 |
|---|---|
| 多模型配置库 | 左栏可给每份配置起名字、保存多个 API Key，落盘到 `data/llm-profiles.json`；接口只回传脱敏信息 |
| 势力下拉选模型 | 「势力操控」下拉列出全部已保存模型；A/B/C/D 可各用一份不同的 Key / 端点 / 模型名 |
| 默认模型 | 其中一份标为「默认」，供选择「AI 大模型（默认）」的势力与旧接口 `/api/llm-game` 使用 |
| Key 严格隔离 | 多模型请求带 `strictKey`，绝不回落到 `.env`；缺 Key 的势力本回合单独降级为脚本 |
| 删除自动清理 | 删除被引用的模型时，该势力引用清掉并退回默认模型，不会卡在失效 id 上 |

**v6.5 / v6.6 的规则变化**

| 变化 | 说明 |
|---|---|
| 全局视野 | `RULES.globalVision = true`：`visibleUnits` / `visibleResources` 直接给全场，`visionScope = "global"` |
| 自动交战 | `RULES.engageRange = 2` + `autoEngage = true`：2 格内自动互射，`attack` 退化为「指定优先目标」 |
| 固定血量 | `RULES.fixedHp = true`：血量恒为 `unitHp`，取消「离基地越远上限越低」；`hpDecay` 保留但不生效 |
| 群殴加成 | 同一目标被 N 人同时攻击，每个攻击者 +（N−1）伤害（上限 +3）；被 ≥2 人围攻时 `defend` 减伤失效 |

**v6.7 的信息与裁判对齐（不改胜负规则）**

| 变化 | 说明 |
|---|---|
| 逐格地图 | `territoryMap` 下发 50×50 逐格归属，与脚本 `territoryAt(game,x,y)` 读到的是同一份网格；`standings` 补四家库存 / 击杀 / 采集，`visibleUnits` 补齐敌方单位的血量 / 攻击 / 泉水字段 |
| 严格 path | `move.path` 首格必须与士兵当前坐标相邻、逐格连续、全部在界内；不合法整条丢弃、不逐点过滤、不纠偏 |
| 对称反馈 | `lastRejected` 公开上一回合**四家**的 `invalid` / `blocked`，同一套口径，不替任何一方修正动作 |
| 日志可查 | `logs/llm-YYYY-MM-DD.log` 同时记 `raw`（模型原文）与 `actions`（实际提交），并带上回合被拒数 |
| 提示词校正 | 求胜准则不再把「全员开垦 / 主动压上」置于经济之上；明确告知脚本对手的采矿造兵节奏与 2 格集火风险 |

**v6.8 的地形与资源变化**

| 变化 | 说明 |
|---|---|
| 连续障碍 | 开局按 seed 生成若干条随机游走的连续深灰带，`wallRatio` 默认 8%、硬上限 10%；四家基地周边 4 格与中央 3 格留空，生成后做连通性修复保证四家都能到达中央。`territoryMap` 用 `#` 表示 |
| 障碍三不通 | 不可通行（path 含 `#` → 整条 `move` 判 `invalid`）、不可占领（`paint` / 包围结算都跳过）、不可布置资源；包围判定时障碍算「缺口」，不会帮任何一家围地 |
| 中央黄金矿 | 固定 (25,25)，1 格，总量无限、永不枯竭、不可摧毁；士兵站上去即占领，持有者每回合 +`goldYield`（默认 2）资源，无需留守；别家踩上来即易主，持有方亡国则归无主 |
| 视图新增 | `wallCount` / `wallRatio` / `goldMine {x,y,owner,yield,produced}`，`mapLegend` 增补 `#`；四家拿到的完全相同 |
| 前端 | 障碍深灰实心填充，黄金矿画成金色八芒星 + 持有者色环；侧栏显示当前持有者与累计产出 |

---

## 1. 通信总览

```
        服务端                                        你（AI 玩家）
          │  N0 game_start   一次性世界观 + 你的身份        │
          │ ─────────────────────────────────────────────▶ │
          │  N1 turn_view    每回合：视野内局面              │
          │ ─────────────────────────────────────────────▶ │ 思考
          │  N2 action       ◀───────────────────────────── │ 一组 JSON 动作
          │  裁判结算（移动 / 包围 / 战斗 / 生产 / 胜负）      │
          │  N3 turn_result  本回合发生了什么 + 新比分        │
          │ ─────────────────────────────────────────────▶ │
          │      …… 循环到回合上限或只剩一家 ……              │
          │  N4 game_over    最终结算                       │
          │ ─────────────────────────────────────────────▶ │
```

四个 AI 是**并行**请求的：同一回合内互相看不到对方的动作，全部提交后一起结算。

---

## 2. 节点明细

### N0 · game_start（一局一次）

| 方向 | 内容 |
|---|---|
| 服务端 → AI | `map`（宽高、总格数）、`you`（A/B/C/D）、`base`（你的基地坐标与耐久）、`factions`（四家名字与颜色）、`rules`（见下表）、`cfg`（本局参数）、`actionSchema` |
| AI → 服务端 | 无需回应 |

`rules` 关键字段：

```json
{
  "claim": "士兵走过的格子 + 周边 8 格重新归己方（含敌方领土）；驻足每回合也翻脚下 3×3",
  "enclosure": {
    "neutral": "中立格四个正交邻格同属一家 → 归该家；地图边界不算围墙",
    "owned": "己方连通块被单一敌家 8 向完全包住、块内没有己方士兵 → 整块易主",
    "snapshot": "基于回合内同一份快照判定，不会连锁吞地"
  },
  "kill": "阵亡点 3×3 易主；攻陷基地则全部领土易主",
  "hp": "固定血量：上限恒为 unitHp，与离基地距离无关（RULES.fixedHp = true）",
  "engage": "敌对士兵切比雪夫距离 ≤ engageRange(2) 即自动互射，伤害 = attack（固定值）",
  "gangUp": "同一目标被 N 个敌对单位同时攻击：每个攻击者 +（N-1）伤害，上限 +3；被 ≥2 人围攻时 defend 减伤失效",
  "spring": "踩过泉水：攻击 +3，持续 4 回合；站在泉水上会一直续",
  "fortress": "站上去即占领，之后每 4 回合自动开垦周围 3×3（只吃中立地）",
  "base": "敌军站上基地格，每个每回合削 siege 点耐久；归零即亡国",
  "alliance": "不存在。四家永远敌对",
  "victory": ["conquest: 只剩一家基地", "territory: 回合耗尽时领土最多"]
}
```

### N1 · turn_view（每回合，一次）

| 方向 | 内容 |
|---|---|
| 服务端 → AI | 一个 JSON，**当前为全局视野**（`RULES.globalVision = true`）：`visibleUnits` / `visibleResources` / `territoryMap` 给的是全场数据，不带战争迷雾；与脚本策略 `buildActions(view, game, ai)` 读到的 `game` 信息等价 |
| AI → 服务端 | 无（这是通知） |

```jsonc
{
  "turn": 37, "maxTurns": 120, "you": "A",
  "myTerritoryCells": 612, "totalCells": 2500,
  "standings": [{"ai":"A","cells":612,"units":7,"alive":true,"stock":18,"kills":4,"harvested":39}, ...],
  "territoryMap": ["AAA....BBB...（共 50 行，每行 50 字符）", "..."],
  "mapGeometry": "50 行 × 50 列；数组第 i 行对应 y=i，行内第 x 个字符对应 x（均从 1 数）",
  "mapLegend": "A/B/C/D=该家领土, .=无主, #=障碍(不可通行/不可占领), ?=视野外",
  "wallCount": 200, "wallRatio": 8,
  "goldMine": {"x":25,"y":25,"owner":"B","yield":2,"produced":46},
  "lastRejected": {
    "A":{"invalid":2,"blocked":0}, "B":{"invalid":0,"blocked":3},
    "C":{"invalid":0,"blocked":0}, "D":{"invalid":0,"blocked":1}
  },
  "stock": 18, "unitCost": 12, "maxUnits": 14, "canProduce": true,
  "moveRange": 3, "attack": 3, "unitHp": 10, "hpFixed": true,
  "engageRange": 2, "autoEngage": true,
  "gangUpBonus": 1, "gangUpMaxBonus": 3, "gangUpBreakAt": 2,
  "units": [
    {"id":"A03","x":21,"y":9,"hp":7,"maxHp":10,"attack":3,"spring":0,"distToBase":18}
  ],
  "visibleUnits":    [{"id":"B04","owner":"B","x":24,"y":10,"hp":5,"maxHp":10,"attack":3,"spring":0,"distToBase":12}],
  "visibleResources":[{"type":"spring","x":23,"y":8,"stock":null,"claimedBy":null}],
  "visionScope":     "global",
  "expandTargets":   [{"x":19,"y":6,"owner":null}],
  "bases": [{"owner":"A","x":4,"y":4,"alive":true,"hp":20,"maxHp":20}, ...],
  "recentEvents": ["A03 饮泉水，攻击力提升"]
}
```

易错点：

- `units[].maxHp` 现在恒为 `unitHp`（默认 10），**不随位置变化**；`hpFixed: true` 就是这个意思。
- `distToBase` 仍会给（切比雪夫距离），但只用来判断回血范围与远征路程，**不再影响血量或伤害**。
- `hpDecay` 参数仍存在（兼容旧配置），固定血量模式下不生效；把 `RULES.fixedHp` 改 `false` 才会恢复旧的距离衰减。
- `visibleUnits` 只含敌人（除自己外的三家全都是敌人），字段与自己的 `units` 已对齐（血量 / 攻击 / 泉水 / 距基地）；`visionScope` 为 `"global"` 时它是全场敌方单位，为 `"local"` 时只含 4 格半径内的。
- **`territoryMap` 是逐格归属，和脚本用 `territoryAt(game,x,y)` 读的是同一份网格**。数组第 i 行 = `y=i`，行内第 x 个字符 = `(x,y)`；`A/B/C/D` 为归属、`.` 为无主、`#` 为**障碍**、`?` 为视野外（仅局部视野模式出现）。`standings` 同时给出四家的库存 / 击杀 / 采集，四家拿到完全等价的局面，没有任何一方开图。
- **`#` 障碍格绝对不能踩**：既不能走进去，也涂不成自己的地，上面不会有资源点。写 path 前先按 `territoryMap` 把 `#` 排除；任何一步落在 `#` 上，整条 `move` 都会被丢弃并计入 `invalid`。想区分「无主」和「墙」，看字符是 `.` 还是 `#`。
- **`goldMine` 是另一条资源来源**：`owner` 是当前持有者（`null` = 无主），`yield` 是每回合自动到账的资源，`produced` 是全局累计。它不需要 `harvest`、不会枯竭、不需要留兵，但别人踩上去就换人；坐标固定 (25,25)，四周没有障碍，四家都能走到。
- **`lastRejected` 是上一回合四家被裁判丢弃（`invalid`）/ 被占位阻挡（`blocked`）的动作数**，口径对脚本和大模型完全一致。裁判只如实公开结果，**不会替任何一方截断、修正或补动作**；看到自己的 `invalid` 不为 0，就要自己改 path、目标或动作类型。
- `expandTargets` 是 8 方向上探到的第一块非己方领土，用来提示「往哪走有新地」。
- `stock` 是造兵资源，来源有两处：普通矿点主动 `harvest`（+3，会枯竭）、中央黄金矿占领后每回合被动入账（无限、可被夺走）。两者互不影响。
- 没有 `alliances` / `pendingProposals` 字段。

### N2 · action（每回合，一次）

| 方向 | 内容 |
|---|---|
| AI → 服务端 | 一个 JSON 对象，只含 `actions` 数组 |
| 服务端 → AI | 无即时回应；结果在 N3 |

```jsonc
{
  "actions": [
    {"unit":"A02","type":"move","path":[[20,10],[21,10],[22,11]]},
    {"unit":"A03","type":"attack","target":"B04"},
    {"unit":"A04","type":"harvest"},
    {"unit":"A05","type":"defend"},
    {"type":"produce"}
  ]
}
```

**动作语法**

| type | 必填 | 说明 | 校验 / 失败处理 |
|---|---|---|---|
| `move` | `unit`, `path` | **首格必须与士兵当前坐标相邻**（切比雪夫距离 1，含斜向），之后逐格连续相邻，最多 `moveRange` 步，坐标全部在 1..50，**且每一步都不能落在 `#` 障碍格上** | **任何一格不合法（含踩墙）→ 整条动作丢弃、该兵原地不动**，计入 `invalid`。路径合法但被其他单位占位挡住 → 在挡住前停下；一步没走成计入 `blocked`。裁判不会截断或纠偏 |
| `attack` | `unit`, `target` | 指定优先打击目标，目标须在交战距离内（≤ `engageRange` = 2 格，切比雪夫）。**交战本身是自动的**，不写 attack 也会打最近的敌人 | 超距 / 目标不可见 → 该动作丢弃并计入 `invalid`（单位仍会按自动规则交火） |
| `harvest` | `unit` | 站在矿点上采集 +3 资源 | 不在矿点 / 矿已枯竭 → 丢弃并计入 `invalid` |
| `defend` | `unit` | 本回合**不开火**，受伤减半，并把脚下 3×3 翻成自己的 | 始终有效 |
| `wait` | `unit` | 什么都不做（默认动作） | 始终有效 |
| `produce` | 无 `unit` | 花 `unitCost` 资源在基地旁造 1 个士兵 | 资源不足 / 已达 `maxUnits` / 无空位 → 跳过；超过每回合 1 次的请求计入 `invalid` |

**每个士兵每回合只能有 1 个动作**，重复动作丢弃并计入 `invalid`；没给动作的士兵自动 `wait`。输出里出现 `allianceOps` 会被直接忽略（结盟已取消）。

> **公平性约定**：以上校验对四家（大模型与脚本）完全同一套代码，不存在「只帮模型修 path」的宽待。所有丢弃都在下一回合通过 `lastRejected` 对称公开。写 `path` 前先读 `units` 里该兵的 `(x,y)` 算第一步，**不要把终点坐标当第一步**。

### N3 · turn_result（每回合，一次）

| 方向 | 内容 |
|---|---|
| 服务端 → AI | `turn`、`events`、`territoryGain`（本回合改判格数）、`territoryCount`、`stock`、`kills`、`unitsAlive`、`bases` |
| AI → 服务端 | 无 |

`events` 示例：`A03 阵亡`、`B 基地被围攻（12/20）`、`C 包围夺取 14 格`、`A 填补中立地 7 格`、`C 攻陷 D 主基地，D 亡国（612 格易主）`。

Web 端另有 `/api/state` 快照，含 `history`（最近 160 回合的 `territory / units / stock / kills / scores / gain / events`），用于右栏趋势图与「本回合 Δ」表。这份数据是**公开**的，不是私有视图。

### N4 · game_over（一局一次）

| 方向 | 内容 |
|---|---|
| 服务端 → AI | `winner`、`winType`（`conquest` / `territory`）、`finalStanding`、`turnsPlayed`、`kills`、`harvested` |
| AI → 服务端 | 无 |

---

## 3. 结算顺序

1. 收集并校验四家动作（**没有外交阶段**，四家同一套校验；丢弃数写入 `rejectedByAI`，下一回合对称公开）
2. **移动**：按士兵 ID 顺序逐格推进，每格 + 周边 8 格重新归己方；**遇到 `#` 障碍格立即停在这一步之前**，涂色也跳过障碍格
3. 驻军把脚下 3×3 重新归己方（同样跳过障碍格）
4. 采集
5. 要塞插旗
6. 泉水加成
7. **围攻基地**（站在基地格上的敌军按人数扣耐久；归零则亡国、全部领土易主）
8. **交战同时结算**：所有与敌对士兵距离 ≤ `engageRange`（2 格）的单位互相开火，伤害 = 攻击力（固定值）；
   声明了 `attack` 的优先打指定目标，`defend` 的单位不开火且受伤减半。
   **群殴**：同一目标本回合被 N 个敌对单位同时攻击时，每个攻击者伤害 +（N−1）×`gangUpBonus`（上限 `gangUpMaxBonus` = 3）；
   被 ≥ `gangUpBreakAt`（2）人围攻时，该目标的 `defend` 减伤失效。先算总伤害再一起扣血；阵亡点 3×3 易主
9. **中央黄金矿**：持有方若已亡国则先归无主；本回合仍站在 (25,25) 的存活单位把矿改判给自己（易主）；
   当前持有者每回合自动 +`goldYield` 资源。矿不枯竭、不需要 `harvest`、不需要留兵驻守
10. 要塞自发扩张（每 4 回合，只吃中立地；跳过障碍格）
11. **包围结算**（中立地四邻填补 + 无守军的被围连通块整块易主；基于快照，不连锁；**障碍格不算围墙，邻到障碍视为有缺口**）
12. 血量：固定上限（不再按距离压血）+ 基地旁回血 + 泉水倒计时
13. 生产
14. 胜负判定 + 写 `history`

---

## 4. 决策要点

1. **开垦靠走，也靠翻**。3 步移动 ≈ 最多 27 格，而且现在能直接把敌方领土涂回来，穿插比圈地更值。
2. **领土要留人**。包围判定看的是「连通块里有没有你的士兵」：一个兵就能保住整块相连的领土；无人区被单一敌家围死就整块丢掉。
3. **远征不再掉血，但也没便宜可占**。血量固定 10 点，走多远都是满血，所以「算距离保血」这条没了；换来的代价是守军同样满血，硬闯更难，靠的是人数与集火。
4. **群殴是这套规则的最优解**。3 个兵围 1 个目标，每人 3+2=5 点，一回合 15 点直接秒杀满血兵；而单挑要打 4 回合。所以优先打队友已经在打的那个敌人，别各打各的。
5. **泉水是便宜的伤害**。+3 攻击等于伤害翻倍，路过就踩。
6. **基地格上的己方士兵是门闩**。敌人必须先杀掉他才能站上基地格，留 1 个兵守家性价比极高。
7. **没有盟友**，任何进入 2 格交战距离的外家士兵都会自动开打；残血兵靠近敌方等于送人头，`defend` 是唯一的止损手段（但被 2 人以上围殴时连减伤也没了）。
8. **绕开 `#`，早点去中央**。障碍是固定地形，绕路只多花 1–2 步，硬往里写 path 则整回合白丢。中央黄金矿四家等距，占住之后每回合白拿资源且不用留守；但别人踩一下就换人，所以它是「谁敢去、谁能守住附近」的长期收益点，不是一次性的矿。

---

## 5. 参数（每局开局可由房主设定，AI 只读）

| 参数 | 含义 | 默认 | 范围 |
|---|---|---|---|
| `turns` | 回合上限 | 120 | 10 – 2000 |
| `unitsPerAI` | 初始士兵数 | 6 | 2 – 16 |
| `maxUnits` | 士兵上限 | 14 | 4 – 40 |
| `unitHp` | 士兵血量上限（固定值，不随位置变化） | 10 | 4 – 40 |
| `hpDecay` | 距离衰减 %/格（`fixedHp = true` 时不生效，仅兼容旧配置） | 1.5 | 0 – 8 |
| `attack` | 初始攻击力 | 3 | 1 – 10 |
| `moveRange` | 每回合移动步数 | 3 | 1 – 8 |
| `unitCost` | 造 1 个士兵的资源 | 12 | 4 – 40 |
| `mines` / `springs` / `fortresses` | 矿点 / 泉水 / 要塞数量 | 24 / 10 / 5 | 6–60 / 0–30 / 0–12 |
| `baseHp` | 基地耐久 | 20 | 10 – 100 |
| `siege` | 每个围攻单位每回合削减的耐久 | 12 | 2 – 30 |
| `wallRatio` | 障碍占总格数百分比（**硬上限 10**） | 8 | 0 – 10 |
| `goldYield` | 中央黄金矿持有者每回合获得的资源 | 2 | 0 – 8 |

固定值：`claimRadius = 1`（走 1 格开垦 3×3）、`producePerTurn = 1`、`harvestYield = 3`、`springAtk = +3`、`springTurns = 4`、`regenNearBase = 2`、`engageRange = 2`、`autoEngage = true`、`fixedHp = true`（血量固定；改 `false` 恢复按距离衰减）、`gangUpBonus = 1`、`gangUpMaxBonus = 3`、`gangUpBreakAt = 2`、`globalVision = true`（全局视野；改 `false` 时按 `vision = 4` 的士兵半径做局部视野）、`wallMaxRatio = 10`（障碍占比硬上限）、`baseSafeRadius = 4` / `goldSafeRadius = 3`（障碍生成保护区）、黄金矿固定坐标 `(25,25)`。

---

## 6. 错误与降级

服务端对 AI 的输出**永不报错**，只做降级：

| 情况 | 处理 |
|---|---|
| 整段输出不是 JSON | 全队 `wait` + 跳过生产 |
| `actions` 不是数组 | 同上 |
| 动作字段缺失 / 类型不对 | 丢弃该动作，该士兵 `wait` |
| 引用了不存在或已阵亡的 `unit` | 丢弃，计入 `invalid` |
| `path` 首格不与士兵当前坐标相邻 / 中间跳格 / 非整数 / 越界 | **整条 `move` 丢弃、该兵原地不动**，计入 `invalid`；不做逐点过滤或截断 |
| `path` 合法但被其他单位占位挡住 | 在挡住前停下；一步没走成计入 `blocked` |
| 攻击了超距 / 不存在 / 自己的单位 | 丢弃，计入 `invalid` |
| `harvest` 时脚下不是有储量的矿点 | 丢弃，计入 `invalid` |
| 同一士兵多个动作 | 只取第一个，其余计入 `invalid` |
| 未给动作的士兵 | 自动 `wait` |
| 额外输出 `allianceOps` | 忽略 |

`server/gameLoop.js` 的顺序是：`extractJSON` → `sanitizeActions`（结构规范化）→ `engine.resolveTurn`（**唯一裁判**：严格校验 + 丢弃计数）。上述规则对大模型和脚本一视同仁，不存在只帮某一方纠偏的宽待。每条被丢弃的动作都能在 `logs/llm-YYYY-MM-DD.log` 的 `raw` 与 `actions` 对照里查到，下一回合的 `lastRejected` 也会把结果还给你。**写 path 前先读 `units` 里该兵的 (x,y)，别把终点当第一步**。

---

## 7. 一个完整的回合示例

**N1 收到（节选）**

```json
{"turn":41,"you":"A","stock":24,"moveRange":3,"attack":3,"unitHp":10,"hpFixed":true,"engageRange":2,
 "units":[{"id":"A02","x":18,"y":12,"hp":6,"maxHp":10,"attack":3,"spring":0,"distToBase":17}],
 "visibleUnits":[{"id":"B07","owner":"B","x":21,"y":13,"hp":4,"maxHp":10,"attack":3,"spring":0,"distToBase":9}],
 "visibleResources":[{"type":"spring","x":20,"y":12}],
 "mapLegend":"A/B/C/D=该家领土, .=无主, #=障碍(不可通行/不可占领), ?=视野外",
 "wallCount":200,"goldMine":{"x":25,"y":25,"owner":null,"yield":2,"produced":0},
 "lastRejected":{"A":{"invalid":0,"blocked":1},"B":{"invalid":0,"blocked":0},"C":{"invalid":0,"blocked":0},"D":{"invalid":0,"blocked":0}}}
```

**N2 提交**

```json
{"actions":[{"unit":"A02","type":"move","path":[[19,12],[20,12]]}]}
```

首格 `(19,12)` 与 A02 当前坐标 `(18,12)` 相邻、第二格继续相邻，整条路径合法；若写成 `[[20,12]]`（直接跳到终点）会被整条丢弃。`lastRejected.A.blocked = 1` 是上回合有兵被占位挡住的反馈。

走位吃到泉水（攻击 +3），顺手把这两格及其周边 8 格从 B 手里翻成 A，停在 B07 旁边的斜角，下回合可以一击致命。

**N3 收到**

```json
{"turn":41,"territoryGain":{"A":31,"B":9,"C":12,"D":15},
 "events":["A02 饮泉水，攻击力提升","A 包围夺取 6 格"],
 "stock":{"A":24,"B":18,"C":30,"D":12}}
```

---

## 8. 运行时接入：API Key、服务商与操控选择

这一节是**房主（人 / 前端）与服务端**之间的接口，不是 LLM 玩家的回合协议。所有接口都返回 JSON，**任何响应都不含明文 API Key**（只给 `keyMask`）。

### 8.1 服务商预设（`server/llm.js`）

| key | 协议 | Base URL | 默认模型 |
|---|---|---|---|
| `openai` | OpenAI 兼容 | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `deepseek` | OpenAI 兼容 | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `qwen` | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `zhipu` | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| `moonshot` | OpenAI 兼容 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| `anthropic` | Anthropic 原生 | `https://api.anthropic.com/v1` | `claude-sonnet-4-5-20250929` |
| `custom` | OpenAI 兼容 | 需手填 | 需手填 |

选预设后**只填 API Key 即可**；`baseURL` / `model` / 温度 / 超时都有默认值。也可把 `OPENAI_API_KEY`（或 `ANTHROPIC_API_KEY`）写进项目 `.env`，启动时自动读取。左栏「记住密钥」会把配置写回 `.env`；不勾选则只存服务端内存。

### 8.2 配置接口

| 节点 | 方法 / 路径 | 请求体 | 返回要点 |
|---|---|---|---|
| 读状态 | `GET /api/llm/config` | — | `hasKey / keyMask / keySource / provider / baseURL / model / presets / controllers / perAI / lastError / profiles / defaultProfileId` |
| 写配置 | `POST /api/llm/config` | `{apiKey?, provider?, baseURL?, model?, temperature?, timeoutMs?, persist?}` | 同上；`persist:true` 写 `.env`；不传 `apiKey` 表示保留当前 Key |
| 连通性 | `POST /api/llm/test` | 同写配置 | `{ok, ms, preview, autoSaved?}`；用刚粘贴但没保存的 Key 测试通过后会自动收下 |
| 清除 | `POST /api/llm/clear` | — | 清内存与 `.env` 里的 Key |

模型请求细节：`OpenAI 兼容` → `POST {baseURL}/chat/completions`，`Authorization: Bearer <key>`；`Anthropic` → `POST {baseURL}/messages`，`x-api-key` + `anthropic-version: 2023-06-01`。默认温度 0.7、`max_tokens` 1200、超时 25 秒（可改 3–120 秒）。

### 8.3 势力操控接口

| 节点 | 方法 / 路径 | 请求体 | 返回 |
|---|---|---|---|
| 读 | `GET /api/controllers` | — | `{controllers, assignment}` |
| 写 | `POST /api/controllers` | `{controllers:{A:{mode,strategy,profileId?},…}}` | 同上 |
| 开局生效 | `POST /api/new` / `/api/auto` | 在原有 `seed/cfg/turns` 之外可带 `controllers` | 常规开局响应 |
| 旧接口 | `POST /api/llm-game` | — | 四家全部切默认大模型并自动开跑 |

`mode`：`'llm'`（每回合请求模型）或 `'bot'`（本地脚本）。
`strategy`：`'auto'`（大模型自主决策 / 脚本按位置取默认打法）或 `aggressive / economist / fortress / turtle`。在 `llm` 模式下它是**提示词人格**；在 `bot` 模式下是真正执行的策略。
`profileId`：**v6.3 新增**，指向一份已保存的模型；不传就走默认模型。服务端会校验该 id 存在，失效引用会被自动丢弃。

`POST /api/controllers` 也接受简写：`{A:'llm', B:'llm:turtle'}` 或旧版策略数组 `['aggressive','economist','fortress','turtle']`。

### 8.4 快照里的新增字段

`/api/state` 与 WebSocket `state` 事件新增：

```json
{
  "controllers": {"A":{"mode":"llm","strategy":"auto","profileId":"m_ab12cd34"}, "…":{}},
  "assignment":  {"A":"llm", "B":"economist", "…":{}},
  "leaderboard": [{"rank":1,"ai":"C","territory":812,"pct":32.5,"units":11,
                   "stock":18,"kills":7,"baseHp":20,"mode":"llm","strategy":"fortress",
                   "profileId":"m_ab12cd34","model":"DeepSeek 主力","llm":{"state":"ok"}}],
  "records":     {"A":{"games":3,"wins":1,"conquest":0,"territory":1800,"best":900}},
  "lastResult":  {"winner":"C","winType":"territory","turn":120},
  "llm":         {"hasKey":true,"keyMask":"sk-••••7890","perAI":{"A":{"state":"ok","ms":830,"model":"DeepSeek 主力"}},
                  "profiles":[{"id":"m_ab12cd34","name":"DeepSeek 主力","providerLabel":"DeepSeek",
                               "model":"deepseek-chat","hasKey":true,"keyMask":"sk-••••7890","isDefault":true}],
                  "defaultProfileId":"m_ab12cd34","lastError":""}
}
```

`profiles` 是**脱敏视图**，永远不含 `apiKey`；`perAI[ai].state` 取值：`idle`（待命）/ `bot`（脚本）/ `ok` / `parse`（输出非 JSON）/ `error`（请求失败）/ `nokey`（没配 Key 或模型被删）。后四种都会**本回合降级为脚本**，前端左侧与排行榜会显示状态与模型名。

### 8.5 降级原则

一回合里四家的动作是并发求值的（`Promise.all`），某一家卡住不会拖住别人：

```
LLM 势力：askLLM(buildPrompt) → extractJSON → sanitizeActions
        └─ 任一环节失败 ─→ 该势力本回合用 strategyForAI() 的脚本策略产出动作
脚本势力：STRATEGIES[strategy].buildActions(view)
所有动作齐了 → engine.resolveTurn(统一结算)
```

因此「没 Key」「Key 过期」「模型返回散文」「超时」都不会让对局停摆，只会在状态里留下原因。

---

## 8.6 多模型配置（v6.3）

一份「模型」= 名称 + 服务商 + API Key + 端点 / 模型名 + 温度 / 超时。保存后落盘到 `data/llm-profiles.json`（`.gitignore` 已忽略），服务重启自动恢复；明文 Key 只留在服务端，**所有响应一律脱敏**。最多 16 份，同名会自动追加 `#2`。

| 节点 | 方法 / 路径 | 请求体 | 返回要点 |
|---|---|---|---|
| 保存 / 更新 | `POST /api/llm/profiles` | `{id?, name, provider, apiKey, baseURL, model, temperature, timeoutMs, makeDefault?, persist?}` | `{profile, profiles, madeDefault, persisted, ...llmPublic}`；带 `id` 为覆盖更新，不传 `apiKey` 则保留旧 Key |
| 按模型测试 | `POST /api/llm/profiles/test` | `{id, apiKey?}` | `{ok, ms, preview, profiles}`；只请求该模型自己的端点 |
| 设为默认 | `POST /api/llm/profiles/default` | `{id}` | `{defaultProfileId, profiles}`；同时同步到 8.2 的通用配置 |
| 删除 | `POST /api/llm/profiles/delete` | `{id}` | `{removed, profiles}`；删掉的是默认模型时自动改选剩下第一份，并清理势力里的失效引用 |
| 列全部 | `GET /api/config` / `/api/llm/config` / `/api/state` | — | `profiles[]` + `defaultProfileId`（也可在 `state.llm` 里读到） |

`profiles[]` 单项字段：`id / name / provider / providerLabel / protocol / baseURL / model / hasKey / keyMask / temperature / maxTokens / timeoutMs / createdAt / testedAt / isDefault`。

**势力绑定的解析优先级**

```
controllers[ai].mode = 'bot'                       → 本地脚本
controllers[ai].mode = 'llm' + profileId          → 该 id 对应的模型（strictKey，只用自己那份 Key）
controllers[ai].mode = 'llm'（无 profileId）       → 默认模型；没有默认模型时回落到 8.2 的通用配置 / .env
```

四家的模型请求在**同一回合内并发**发出，互不阻塞；某一份 Key 失效只影响绑定它的那一家。前端左栏「已保存的模型」支持载入编辑、设为默认、单独测试与删除（二次确认）；「势力操控」下拉用 `optgroup` 列出全部已保存模型，选中即把 `profileId` 写进该势力的控制器。

---

## 9. 对局记忆与策略自适应（v6.4）

LLM 每次请求都是**无状态**的：不回灌历史，模型既不知道自己上回合做了什么，也不知道过去几十局输在哪。v6.4 在服务端加了一层记忆，把结果按三个时间尺度回灌进 `buildPrompt(view, strat, recall)` 的第三参。

### 9.1 三层记忆

| 尺度 | 数据来源 | 注入内容 | 作用 |
|---|---|---|---|
| 局内（上一回合） | `metricsFor()` 前后快照 + `actionsByAI` + `eventsFor()` | `【上回合反馈】你上回合 行军×3、采集×1；结果 领土 +38、士兵 -1…` | 让模型立刻看到自己决策的后果，纠正重复失误 |
| 跨局（最近 N 局） | `data/llm-memory.json` 的 `matches[]` | `【跨局战绩】累计 12 局 / 3 胜（25%），其中大模型操控 8 局 / 2 胜；平均名次 2.4` + 最近 3 局 + 常见败因 | 让模型知道自己长期弱项（后期被翻地 / 前期开垦慢 / 零击杀） |
| 经验（跨会话） | 局末复盘 `deriveLessons()` 或手动 `/api/memory/reflect` | `【过往经验｜建议，不是硬规则，以当前局面为准】1. 开局留 1 兵…` | 把复盘结论变成下一局可执行的动作建议 |

记忆块**限长 1200 字符**，超出会截断；关闭 `enabled` 后完全不注入，但战绩仍继续累计。

### 9.2 数据流

```
tick() 开始    → 记录四家 territory / units / stock / kills / baseHp 快照
LLM 分支       → memory.recall(ai, turnFeedback[ai]) → buildPrompt(..., recall)
resolveTurn()  → buildFeedback(before, after, actions, events) 写入 turnFeedback[ai]
game.over      → memory.record(game, {controllers, modelLabels})
                 ├─ summarizeMatch()  一局结构化摘要（名次 / 领土曲线 / 分段增量 / 亡国回合）
                 ├─ annotateCauses()  跨家比较，标注败因
                 ├─ deriveLessons()   规则化复盘，只为 mode='llm' 的势力生成经验
                 └─ 经验有效性回写  uses / winAfter（这条经验被注入后赢了几局）
下一局 / 下一回合 → 上述内容重新进入提示词，闭环
```

`deriveLessons()` 是**纯规则**的：不调用模型、不花钱、结果可复现，因此即使没配 Key 也会积累经验。可选的 `/api/memory/reflect` 才用模型复盘，需手动触发，避免每局自动烧 token。

### 9.3 提示词输出格式的变化

`buildPrompt()` 在输出 JSON 里新增一个可选字段 `"note"`，模型可用一句话写下本回合依据；`sanitizeActions()` 会忽略它，旧版只输出 `actions` 的模型**完全兼容**。服务端把 `note` 存进 `llm.perAI[ai].note`，便于事后追溯。

### 9.4 接口

| 节点 | 方法 / 路径 | 请求体 | 返回要点 |
|---|---|---|---|
| 读记忆 | `GET /api/memory` | — | `{enabled, reflectEnabled, maxLessons, totalMatches, lastMatch, matches[8], lessons, stats, updatedAt}` |
| 开关设置 | `POST /api/memory/config` | `{enabled?, reflectEnabled?, maxLessons?}` | 同上的完整视图 |
| 清空 | `POST /api/memory/clear` | — | 清空 matches / lessons，保留开关配置 |
| 手记 / 删经验 | `POST /api/memory/lesson` | `{ai, text}` 或 `{action:'remove', ai, id}` | 完整视图 |
| 模型复盘 | `POST /api/memory/reflect` | `{ai?, profileId?}` | `{ok, ai, model, added[]}`；把上一局数据交给选中模型，产出 1~3 条经验 |

### 9.5 快照新增字段

```json
{
  "records": {"A":{"games":12,"wins":3,"conquest":1,"territory":7300,"best":910}},
  "memory":  {"enabled":true,"totalMatches":12,
              "stats":{"A":{"winRate":25,"llmWinRate":28.6,"avgRank":2.4,"causes":[{"name":"后期领土被翻","n":4}]}},
              "lessons":{"A":[{"id":"ls_ab12","text":"开局留 1 兵…","kind":"rule","uses":6,"winAfter":2}]}},
  "feedback": {"A":"你上回合 行军×3…；结果 领土 +38、士兵 -1…"}
}
```

`records` 从 v6.3 的「本机会话内存计数」改为**跨重启累计**，四家共用同一份 `matches[]` 派生，不会与右栏数字打架。`leaderboard[].winRate` 也来自同一份统计。

### 9.6 防止「越学越差」的四条约束

1. **经验是建议不是规则**：提示词明确写「以当前局面为准」，且只注入排序前 3 条，避免历史结论压过实时信息。
2. **按势力隔离**：A/B/C/D 各自一套 `lessons`；脚本势力的对局只进战绩，不生成经验，避免把本地脚本的行为归因成模型决策。
3. **有效性可观测**：每条经验记录 `uses`（被注入次数）与 `winAfter`（注入后赢了几局），按净胜场排序；前端右栏直接显示，可手动删掉无效经验。
4. **可随时关掉做 A/B**：`POST /api/memory/config {enabled:false}` 即回到 v6.3 行为。验证胜率是否真的提高，要用**同一 seed、同一对手配置**分别跑 N 局开 / 关两组，比较 `stats[ai].llmWinRate`；只看单局胜负说明不了问题。

> 这里做的是**上下文学习（in-context learning）**，不改变模型权重。它的上限取决于模型能否读懂并采纳提示词里的经验；想进一步提升，可把 `matches[]` 导出做离线分析或微调，但那已超出本项目的运行时范围。
