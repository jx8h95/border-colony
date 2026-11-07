// server/memory.js — 对局记忆（v6.4）
// 让无状态的大模型获得三种时间尺度的反馈：局内 Δ、跨局战绩、局末复盘经验。
// 纯函数（summarizeMatch / deriveLessons / buildRecall / buildFeedback）便于单测；
// MatchMemory 负责跨重启持久化与「经验有没有真的提高胜率」的回写统计。
import path from 'path';
import { randomUUID } from 'crypto';
import { AI_IDS, CELLS, displayRanking } from './engine.js';
import { readJsonSafe, writeJsonAtomic } from './jsonStore.js';

export const MAX_MATCHES = 60;
export const MAX_LESSONS = 6;
export const RECALL_MATCHES = 3;
export const RECALL_CHAR_LIMIT = 1200;

const str = (v, max = 220) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const uid = prefix => `${prefix}_${randomUUID().slice(0, 8)}`;
const pct = n => +((num(n) / CELLS) * 100).toFixed(1);

const ACTION_CN = {
  move: '行军', attack: '攻击', harvest: '采集', defend: '防守',
  wait: '待命', produce: '造兵',
};

export function freshMemory() {
  return {
    version: 2,
    updatedAt: null,
    enabled: true,
    reflectEnabled: true,
    maxLessons: MAX_LESSONS,
    matches: [],
    lessons: Object.fromEntries(AI_IDS.map(a => [a, []])),
  };
}

/* ---------------- 归一化（文件损坏 / 旧版本都要能读） ---------------- */

function normalizeLesson(l) {
  if (!l || typeof l !== 'object') return null;
  const text = str(l.text);
  if (!text) return null;
  return {
    id: typeof l.id === 'string' ? l.id : uid('ls'),
    text,
    kind: ['llm', 'manual'].includes(l.kind) ? l.kind : 'rule',
    matchId: typeof l.matchId === 'string' ? l.matchId : null,
    at: typeof l.at === 'string' ? l.at : null,
    uses: Math.max(0, Math.floor(num(l.uses))),
    winAfter: Math.max(0, Math.floor(num(l.winAfter))),
    hits: Math.max(1, Math.floor(num(l.hits, 1))),
  };
}

function normalizePlayer(p) {
  const q = p && typeof p === 'object' ? p : {};
  return {
    mode: q.mode === 'llm' ? 'llm' : 'bot',
    strategy: str(q.strategy, 40) || 'auto',
    model: str(q.model, 80),
    rank: clamp(q.rank, 1, AI_IDS.length, 4),
    won: !!q.won,
    alive: q.alive !== false,
    territory: Math.max(0, Math.floor(num(q.territory))),
    pct: clamp(q.pct, 0, 100, 0),
    units: Math.max(0, Math.floor(num(q.units))),
    kills: Math.max(0, Math.floor(num(q.kills))),
    stock: Math.max(0, Math.floor(num(q.stock))),
    baseHp: Math.max(0, Math.floor(num(q.baseHp))),
    peak: Math.max(0, Math.floor(num(q.peak))),
    peakTurn: Math.max(0, Math.floor(num(q.peakTurn))),
    endDrop: Math.max(0, Math.floor(num(q.endDrop))),
    earlyGain: Math.floor(num(q.earlyGain)),
    midGain: Math.floor(num(q.midGain)),
    lateGain: Math.floor(num(q.lateGain)),
    avgGain: +num(q.avgGain).toFixed(1),
    diedAt: q.diedAt == null ? null : Math.max(0, Math.floor(num(q.diedAt))),
    causes: Array.isArray(q.causes) ? q.causes.filter(c => typeof c === 'string').slice(0, 6).map(c => str(c, 40)) : [],
    usedLessons: Array.isArray(q.usedLessons) ? q.usedLessons.filter(x => typeof x === 'string').slice(0, 20) : [],
  };
}

function normalizeMatch(m) {
  const q = m && typeof m === 'object' ? m : {};
  const perAI = Object.fromEntries(AI_IDS.map(ai => [ai, normalizePlayer(q.perAI?.[ai])]));
  return {
    id: typeof q.id === 'string' ? q.id : uid('mt'),
    at: typeof q.at === 'string' ? q.at : null,
    seed: num(q.seed),
    serial: Math.max(0, Math.floor(num(q.serial))),
    turn: Math.max(0, Math.floor(num(q.turn))),
    maxTurns: Math.max(1, Math.floor(num(q.maxTurns, 120))),
    winner: AI_IDS.includes(q.winner) ? q.winner : null,
    winType: str(q.winType, 40) || null,
    standings: Array.isArray(q.standings) ? q.standings.filter(a => AI_IDS.includes(a)) : [...AI_IDS],
    perAI,
  };
}

export function normalizeMemory(raw) {
  const out = freshMemory();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.reflectEnabled === 'boolean') out.reflectEnabled = raw.reflectEnabled;
  out.maxLessons = Math.floor(clamp(raw.maxLessons, 1, 12, MAX_LESSONS));
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  if (Array.isArray(raw.matches)) {
    out.matches = raw.matches
      .filter(m => m && typeof m === 'object' && m.perAI)
      .slice(0, MAX_MATCHES).map(normalizeMatch);
  }
  if (raw.lessons && typeof raw.lessons === 'object') {
    for (const ai of AI_IDS) {
      out.lessons[ai] = (Array.isArray(raw.lessons[ai]) ? raw.lessons[ai] : [])
        .map(normalizeLesson).filter(Boolean).slice(0, 12);
    }
  }
  return out;
}

/* ---------------- 一局的结构化摘要 ---------------- */

function curveFor(game, ai) {
  const h = Array.isArray(game.history) ? game.history : [];
  const at = i => num(h[Math.min(h.length - 1, Math.max(0, i))]?.territory?.[ai]);
  const first = at(0);
  const t1 = at(Math.floor(h.length / 3));
  const t2 = at(Math.floor(h.length * 2 / 3));
  const last = num(game.territoryCount?.[ai], at(h.length - 1));

  let peak = last, peakTurn = num(game.turn);
  let gainSum = 0;
  let diedAt = null;
  for (const e of h) {
    const t = num(e?.territory?.[ai]);
    if (t > peak) { peak = t; peakTurn = num(e?.turn); }
    gainSum += num(e?.gain?.[ai]);
    if (diedAt === null && num(e?.turn) > 0 && t === 0) diedAt = num(e?.turn);
  }
  return {
    peak, peakTurn,
    endDrop: Math.max(0, peak - last),
    earlyGain: t1 - first,
    midGain: t2 - t1,
    lateGain: last - t2,
    avgGain: +(gainSum / Math.max(1, h.length - 1)).toFixed(1),
    diedAt,
  };
}

/**
 * 把一局结束时的 game 提炼成可长期保存的摘要。meta: {serial, controllers, modelLabels}
 * 纯函数：只读取 game，不修改它。
 */
export function summarizeMatch(game, meta = {}) {
  const ctrl = meta.controllers || {};
  const labels = meta.modelLabels || {};
  const standings = displayRanking(game);
  const perAI = {};

  for (const ai of AI_IDS) {
    const c = ctrl[ai] || {};
    const territory = num(game.territoryCount?.[ai]);
    perAI[ai] = normalizePlayer({
      mode: c.mode === 'llm' ? 'llm' : 'bot',
      strategy: c.strategy || 'auto',
      model: str(labels[ai] || '', 80),
      rank: standings.indexOf(ai) + 1,
      won: game.winner === ai,
      alive: !!game.bases?.[ai]?.alive,
      territory,
      pct: pct(territory),
      units: (game.units || []).filter(u => u.owner === ai && u.alive).length,
      kills: num(game.kills?.[ai]),
      stock: num(game.stock?.[ai]),
      baseHp: num(game.bases?.[ai]?.hp),
      ...curveFor(game, ai),
    });
  }

  return normalizeMatch({
    id: uid('mt'),
    at: new Date().toISOString(),
    seed: num(game.seed),
    serial: meta.serial,
    turn: num(game.turn),
    maxTurns: num(game.maxTurns, 120),
    winner: game.winner || null,
    winType: game.winType || null,
    standings,
    perAI,
  });
}

/** 跨家比较后标注败因，供统计与复盘使用 */
export function annotateCauses(match) {
  const players = match.perAI || {};
  const bestEarly = Math.max(0, ...AI_IDS.map(a => num(players[a]?.earlyGain)));
  for (const ai of AI_IDS) {
    const p = players[ai];
    if (!p) continue;
    const c = [];
    if (!p.alive || p.diedAt != null) c.push('主基地被攻陷');
    if (p.endDrop >= 180 && p.endDrop > p.peak * 0.3) c.push('后期领土被翻');
    if (p.units === 0) c.push('兵力耗尽');
    if (bestEarly > 0 && p.earlyGain < bestEarly * 0.55) c.push('前期开垦偏慢');
    if (p.kills === 0) c.push('零击杀');
    p.causes = p.won ? [] : c.slice(0, 4);
  }
  return match;
}

/** 规则化复盘：从数据推出「下次该怎么做」，不依赖外部模型、不花钱、可复现 */
export function deriveLessons(match, ai) {
  const p = match?.perAI?.[ai];
  if (!p) return [];
  const rivals = AI_IDS.filter(x => x !== ai).map(x => match.perAI?.[x]).filter(Boolean);
  const bestEarly = Math.max(0, ...rivals.map(r => num(r.earlyGain)));
  const bestLate = Math.max(0, ...rivals.map(r => num(r.lateGain)));
  const out = [];

  if (!p.alive || p.diedAt != null) {
    out.push(`上局 T${p.diedAt ?? match.turn} 主基地被攻陷而亡国；开局起固定留 1 名士兵站在基地格上，再留 1 名在基地 3 格内巡逻，不要全员远征。`);
  }
  if (p.endDrop >= 180 && p.endDrop > p.peak * 0.3) {
    out.push(`上局领土在 T${p.peakTurn} 见顶 ${p.peak} 格、终局只剩 ${p.territory} 格（失地 ${p.endDrop}）；大块领土里必须留驻军，否则被单一敌家 8 向包围会整块易主。`);
  }
  if (p.alive && p.units === 0) {
    out.push('上局终局 0 名存活士兵；采矿造兵是唯一补兵渠道，资源够时优先 produce，别把兵全拿去换击杀。');
  }
  if (bestEarly > 0 && p.earlyGain < bestEarly * 0.55) {
    out.push(`上局前 1/3 只开垦 ${p.earlyGain} 格，对手最快 ${bestEarly} 格；前期让多名士兵分头沿不同方向走未占领区，走过即翻旗，别挤在同一条路上。`);
  }
  if (p.won) {
    const strong = p.lateGain >= bestLate
      ? `后期仍净增 ${p.lateGain} 格`
      : `中期净增 ${p.midGain} 格`;
    out.push(`上局获胜（第 1 名，${p.territory} 格 / ${p.pct}%），关键在${strong}；沿用「分兵开垦 + 至少 1 兵守家」的节奏，别在领先后全员压上。`);
  } else if (p.lateGain < 0 && bestLate > 0) {
    out.push(`上局后 1/3 领土净变化 ${p.lateGain} 格，对手同期最多 +${bestLate}；终盘前 15 回合要主动翻敌方边境格并守住己方连通块，别只防守。`);
  }
  if (p.kills === 0 && !p.won) {
    out.push('上局 0 击杀；遇到相邻敌方孤兵时优先 attack，击杀点 3×3 会直接易主，是低成本抢地手段。');
  }
  // 兜底：指标都很平的时候也要给一条能直接照做的建议，复盘不允许返回空
  if (!out.length) {
    out.push(`上局终局第 ${p.rank} 名（${p.territory} 格 / ${p.units} 兵）；下局让 2 名士兵分头走未占领的格子开垦，留 1 名守住基地格，资源够就立刻 produce，别把兵挤在同一条路上。`);
  }
  return out.slice(0, 3);
}

/* ---------------- 局内反馈 ---------------- */

const signed = n => (n > 0 ? `+${n}` : String(n));

/** 上回合「做了什么 → 得到什么」；before/after 是单家势力的五项数值 */
export function buildFeedback(before, after, actions = [], events = []) {
  if (!before || !after) return '';
  const d = k => num(after[k]) - num(before[k]);
  const count = {};
  for (const a of (Array.isArray(actions) ? actions : [])) {
    const t = a && typeof a === 'object' ? (a.type || 'wait') : 'wait';
    count[t] = (count[t] || 0) + 1;
  }
  const did = Object.entries(count)
    .map(([k, v]) => `${ACTION_CN[k] || k}×${v}`).join('、') || '未行动';
  const ev = (Array.isArray(events) ? events : []).filter(Boolean).slice(0, 3).map(e => str(e, 60)).join('；');
  return `你上回合 ${did}；结果 领土 ${signed(d('territory'))}、士兵 ${signed(d('units'))}、资源 ${signed(d('stock'))}、击杀 ${signed(d('kills'))}、基地耐久 ${signed(d('baseHp'))}${ev ? `；事件：${ev}` : ''}。若某项明显变差，本回合先补短板。`;
}

/* ---------------- 统计与召回 ---------------- */

export function statsFor(memory, ai) {
  const all = (memory?.matches || []).filter(m => m?.perAI?.[ai]);
  const llmOnly = all.filter(m => m.perAI[ai].mode === 'llm');
  const wins = all.filter(m => m.perAI[ai].won).length;
  const llmWins = llmOnly.filter(m => m.perAI[ai].won).length;
  const territory = all.reduce((s, m) => s + num(m.perAI[ai].territory), 0);
  const causes = new Map();
  for (const m of all) {
    if (m.perAI[ai].won) continue;
    for (const c of m.perAI[ai].causes || []) causes.set(c, (causes.get(c) || 0) + 1);
  }
  return {
    games: all.length,
    wins,
    conquest: all.filter(m => m.perAI[ai].won && m.winType === 'conquest').length,
    territory,
    best: Math.max(0, ...all.map(m => num(m.perAI[ai].territory))),
    avgRank: all.length ? +(all.reduce((s, m) => s + num(m.perAI[ai].rank, 4), 0) / all.length).toFixed(1) : 0,
    avgTerritory: all.length ? Math.round(territory / all.length) : 0,
    winRate: all.length ? +(wins / all.length * 100).toFixed(1) : 0,
    llmGames: llmOnly.length,
    llmWins,
    llmWinRate: llmOnly.length ? +(llmWins / llmOnly.length * 100).toFixed(1) : 0,
    recent: all.slice(0, 5).map(m => ({
      rank: m.perAI[ai].rank, won: m.perAI[ai].won,
      territory: m.perAI[ai].territory, turn: m.turn, winType: m.winType,
    })),
    causes: [...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, n]) => ({ name, n })),
  };
}

/** 经验按「注入后的净胜场」排序，样本太少时不至于霸榜 */
export function rankedLessons(list = []) {
  return [...list].sort((a, b) => {
    const score = l => num(l.winAfter) - 0.4 * num(l.uses) + 0.5 * Math.log1p(num(l.hits, 1));
    return score(b) - score(a) || num(b.at ? Date.parse(b.at) : 0) - num(a.at ? Date.parse(a.at) : 0);
  });
}

/** 生成注入提示词的记忆块；返回 '' 表示不注入 */
export function buildRecall(memory, ai, { feedback = '', force = false } = {}) {
  if (!memory || (!memory.enabled && !force)) return '';
  const s = statsFor(memory, ai);
  const parts = [];

  if (feedback) parts.push(`【上回合反馈】${str(feedback, 400)}`);

  if (s.games) {
    parts.push(`【跨局战绩】累计 ${s.games} 局 / ${s.wins} 胜（${s.winRate}%），其中由大模型操控 ${s.llmGames} 局 / ${s.llmWins} 胜；平均名次 ${s.avgRank}，平均终局领土 ${s.avgTerritory} 格。`);
    if (s.recent.length) {
      parts.push(`【最近 ${s.recent.length} 局】` + s.recent.map(r =>
        `第${r.rank}名·${r.won ? '胜' : '负'}·${r.territory}格`).join(' ｜ '));
    }
    if (s.causes.length) {
      parts.push('【常见败因】' + s.causes.map(c => `${c.name} ${c.n} 次`).join('；') + '。');
    }
  }

  const lessons = rankedLessons(memory.lessons?.[ai] || []).slice(0, 3);
  if (lessons.length) {
    parts.push('【过往经验｜建议，不是硬规则，以当前局面为准】\n'
      + lessons.map((l, i) => `  ${i + 1}. ${l.text}`).join('\n'));
  }

  if (!parts.length) return '';
  const full = `【历史记忆 · 势力 ${ai}】\n${parts.join('\n')}`;
  return full.length > RECALL_CHAR_LIMIT
    ? `${full.slice(0, RECALL_CHAR_LIMIT - 16)}\n…（记忆已截断）`
    : full;
}

/* ---------------- 大模型复盘（手动触发，不自动烧 token） ---------------- */

/** 把上一局摘要交给大模型，请它输出可执行的经验条目 */
export function buildReflectPrompt(match, ai) {
  const p = match?.perAI?.[ai];
  if (!p) return '';
  const brief = {
    you: ai,
    winner: match.winner,
    winType: match.winType,
    turns: `${match.turn}/${match.maxTurns}`,
    standings: match.standings,
    result: {
      rank: p.rank, won: p.won, alive: p.alive, territory: p.territory, pct: p.pct,
      peak: p.peak, peakTurn: p.peakTurn, endDrop: p.endDrop,
      earlyGain: p.earlyGain, midGain: p.midGain, lateGain: p.lateGain,
      units: p.units, kills: p.kills, stock: p.stock, baseHp: p.baseHp,
      causes: p.causes,
    },
    rivals: Object.fromEntries(AI_IDS.filter(x => x !== ai).map(x => [x, {
      territory: num(match.perAI?.[x]?.territory),
      earlyGain: num(match.perAI?.[x]?.earlyGain),
      lateGain: num(match.perAI?.[x]?.lateGain),
    }])),
  };

  return `你是《边界殖民地》势力 ${ai} 的复盘教练。下面是刚结束的一局数据，请找出导致胜负的关键决策失误或有效做法。

对局数据（JSON）：
${JSON.stringify(brief, null, 2)}

规则要点：地图里深灰障碍格不可通行、不可占领、不能踩，路径写进去会被整条丢弃；士兵走过的格子及周围 8 格立即归己方，敌方领土走过即翻旗；一块连通领土若被单一敌家 8 向包围且其中没有己方士兵，整块易主；敌方士兵站在主基地格上会每回合削耐久，归零亡国、全部领土归攻方；资源可采普通矿点获得，中央黄金矿则是站上去占领后每回合被动产出（可被别人踩走易主），造兵耗资源；泉水加攻击；士兵血量固定（不再随距离衰减）；敌对士兵距离 ≤ 2 格自动互射，伤害固定；多人围殴同一目标时每人伤害递增且能破掉 defend 的减伤。

请只输出一个 JSON 对象，不要解释：
{"lessons":["建议1","建议2","建议3"]}
要求：1~3 条，每条不超过 60 字，必须是下一局能直接照做的具体动作（例如「开局留 1 兵站基地格」），不要写「要注意防守」这类空话，不要复述数据，不要重复同一意思。

唯一目标是下一局赢，而且是拿第一：与其给一条「稳妥点」的建议，不如给一条具体、大胆、能直接换来领土或击杀的做法。这条输掉的局里，哪一步换成进攻就能改写结果，就写那一步。`;
}

/* ---------------- 持久化 ---------------- */

export class MatchMemory {
  constructor(file) {
    this.file = file;
    this.data = freshMemory();
    this.active = Object.fromEntries(AI_IDS.map(a => [a, new Set()]));
    this.load();
  }

  load() {
    this.data = normalizeMemory(readJsonSafe(this.file, freshMemory()));
  }

  save() {
    try {
      this.data.updatedAt = new Date().toISOString();
      writeJsonAtomic(this.file, this.data);
    } catch (e) {
      console.error('[memory] 写入失败:', e.message);
    }
  }

  stats(ai) { return statsFor(this.data, ai); }
  lastMatch() { return this.data.matches[0] || null; }

  /** 开新局：清掉「上一局注入过哪些经验」的临时标记，避免未跑完的局污染统计 */
  beginMatch() {
    this.active = Object.fromEntries(AI_IDS.map(a => [a, new Set()]));
  }

  /** 生成提示词记忆，并记下本局注入过哪些经验（用于事后统计有效性） */
  recall(ai, feedback = '') {
    const text = buildRecall(this.data, ai, { feedback });
    if (!text) return '';
    for (const l of rankedLessons(this.data.lessons[ai] || []).slice(0, 3)) {
      this.active[ai].add(l.id);
    }
    return text;
  }

  /** 归档一局：写战绩、按规则复盘、回写经验有效性 */
  record(game, meta = {}) {
    const match = annotateCauses(summarizeMatch(game, meta));
    this.data.matches.unshift(match);
    this.data.matches = this.data.matches.slice(0, MAX_MATCHES);

    for (const ai of AI_IDS) {
      const p = match.perAI[ai];
      p.usedLessons = [...this.active[ai]];
      for (const l of this.data.lessons[ai] || []) {
        if (!this.active[ai].has(l.id)) continue;
        l.uses = num(l.uses) + 1;
        if (p.won) l.winAfter = num(l.winAfter) + 1;
      }
      this.active[ai] = new Set();
      if (this.data.reflectEnabled && p.mode === 'llm') {
        for (const text of deriveLessons(match, ai)) this.addLesson(ai, text, 'rule', match.id, false);
      }
    }
    this.trimLessons();
    this.save();
    return match;
  }

  trimLessons() {
    for (const ai of AI_IDS) {
      const list = rankedLessons(this.data.lessons[ai] || []);
      this.data.lessons[ai] = list.slice(0, this.data.maxLessons);
    }
  }

  addLesson(ai, text, kind = 'rule', matchId = null, doSave = true) {
    if (!AI_IDS.includes(ai)) return null;
    const t = str(text);
    if (!t) return null;
    const list = this.data.lessons[ai] || (this.data.lessons[ai] = []);
    const hit = list.find(l => l.text === t);
    if (hit) {
      hit.hits = num(hit.hits, 1) + 1;
      hit.at = new Date().toISOString();
      if (doSave) this.save();
      return hit;
    }
    const l = {
      id: uid('ls'), text: t, kind: ['llm', 'manual'].includes(kind) ? kind : 'rule',
      matchId, at: new Date().toISOString(), uses: 0, winAfter: 0, hits: 1,
    };
    list.unshift(l);
    this.trimLessons();
    if (doSave) this.save();
    return l;
  }

  removeLesson(ai, id) {
    if (!AI_IDS.includes(ai)) return false;
    const before = (this.data.lessons[ai] || []).length;
    this.data.lessons[ai] = (this.data.lessons[ai] || []).filter(l => l.id !== id);
    this.save();
    return (this.data.lessons[ai] || []).length < before;
  }

  setConfig(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.data.enabled = patch.enabled;
    if (typeof patch.reflectEnabled === 'boolean') this.data.reflectEnabled = patch.reflectEnabled;
    if (patch.maxLessons !== undefined) {
      this.data.maxLessons = Math.floor(clamp(patch.maxLessons, 1, 12, MAX_LESSONS));
      this.trimLessons();
    }
    this.save();
    return this.config();
  }

  config() {
    return {
      enabled: this.data.enabled,
      reflectEnabled: this.data.reflectEnabled,
      maxLessons: this.data.maxLessons,
    };
  }

  clear() {
    const cfg = this.config();
    this.data = { ...freshMemory(), ...cfg };
    this.active = Object.fromEntries(AI_IDS.map(a => [a, new Set()]));
    this.save();
  }

  /** 兼容旧版 /api/state 的 records 字段（现在跨重启累计） */
  recordsView() {
    return Object.fromEntries(AI_IDS.map(ai => {
      const s = this.stats(ai);
      return [ai, {
        games: s.games, wins: s.wins, conquest: s.conquest,
        territory: s.territory, best: s.best,
      }];
    }));
  }

  /** 前端只读视图：不含 Key，不含完整逐局 details */
  publicView() {
    return {
      ...this.config(),
      updatedAt: this.data.updatedAt,
      totalMatches: this.data.matches.length,
      file: path.basename(this.file),
      lastMatch: this.data.matches[0] ? {
        id: this.data.matches[0].id,
        at: this.data.matches[0].at,
        turn: this.data.matches[0].turn,
        winner: this.data.matches[0].winner,
        winType: this.data.matches[0].winType,
        standings: this.data.matches[0].standings,
      } : null,
      matches: this.data.matches.slice(0, 8).map(m => ({
        id: m.id, at: m.at, turn: m.turn, winner: m.winner, winType: m.winType,
        perAI: Object.fromEntries(AI_IDS.map(ai => [ai, {
          rank: m.perAI[ai].rank, won: m.perAI[ai].won,
          territory: m.perAI[ai].territory, mode: m.perAI[ai].mode,
          model: m.perAI[ai].model, causes: m.perAI[ai].causes,
        }])),
      })),
      lessons: Object.fromEntries(AI_IDS.map(ai => [ai, rankedLessons(this.data.lessons[ai] || [])])),
      stats: Object.fromEntries(AI_IDS.map(ai => [ai, this.stats(ai)])),
    };
  }
}
