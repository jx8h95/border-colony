// server/index.js — Express + Socket.IO 入口（v6.4）
// 每势力可独立选择「自动策略」「默认大模型」或「某一份已保存的模型」；失败自动降级，绝不卡住对局。
// v6.4：对局记忆闭环 —— 局内 Δ 反馈、跨局战绩、局末复盘经验回灌提示词。
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createGame, resolveTurn, getViewFor, encodeTerritory, maxHpAt, attackOf,
  AI_IDS, MAP_W, MAP_H, CELLS, aliveCount, displayRanking, factionAlive,
  CFG_DEF, CFG_LIMITS, CFG_LABEL, RULES, normalizeCfg,
} from './engine.js';
import { STRATEGIES } from './bots.js';
import {
  PROVIDERS, resolveConfig, askLLMDetailed, testLLM, maskKey, extractJSON, assertSafeBaseURL,
} from './llm.js';
import { logLLMTrace, currentLogFile } from './logger.js';
import {
  ProfileVault, profileConfig, publicProfile, displayName,
} from './profiles.js';
import {
  MatchMemory, buildFeedback, buildReflectPrompt,
} from './memory.js';
import {
  normalizeControllers, strategyForAI, DEFAULT_CONTROLLERS, STYLE_OPTIONS,
} from './controllers.js';
import { buildPrompt, sanitizeActions, styleFor } from './gameLoop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const VALID_STRATEGIES = Object.keys(STRATEGIES).filter(k => k !== 'diplomat');
const PROVIDER_LIST = Object.entries(PROVIDERS).map(([key, p]) => ({
  key, label: p.label, protocol: p.protocol, baseURL: p.baseURL, model: p.model,
}));
// 官方预设端点：换到这些地址时允许沿用已保存的 Key；其它自定义端点必须自带 Key
const PRESET_URLS = new Set(PROVIDER_LIST.map(p => p.baseURL).filter(Boolean));
const normURL = u => String(u || '').trim().replace(/\/+$/, '');

let activeGame = null;
let activeCfg = { ...CFG_DEF };
let autoTimer = null, autoRunning = false, ticking = false;
let controllers = DEFAULT_CONTROLLERS();
let assignment = assignmentFromControllers();
let gameSerial = 0, recordedSerial = -1;
let lastResult = null;

// 密钥只存运行时内存（或本机 .env / profiles.json），绝不出现在任何 API 响应里
let llmRuntime = {
  provider: 'openai', apiKey: '', baseURL: '', model: '',
  temperature: 0.7, maxTokens: 1200, timeoutMs: 25000,
};

// 多份已保存的模型：势力下拉可按 id 各选一份，互不串 Key
// 测试可用 LLM_PROFILES_FILE 指到临时文件，避免污染本机配置
const PROFILE_FILE = process.env.LLM_PROFILES_FILE || path.join(__dirname, '../data/llm-profiles.json');
const vault = new ProfileVault(PROFILE_FILE);

// 对局记忆：战绩与经验跨重启保留；测试可用 LLM_MEMORY_FILE 指到临时文件
const MEMORY_FILE = process.env.LLM_MEMORY_FILE || path.join(__dirname, '../data/llm-memory.json');
const memory = new MatchMemory(MEMORY_FILE);

const freshPerAI = () => Object.fromEntries(AI_IDS.map(ai => [ai, { state: 'idle' }]));
let llmState = { tested: false, lastError: '', lastOkAt: null, perAI: freshPerAI() };

/** 默认模型（势力选「AI 大模型（默认）」时用）：重启后从本机文件恢复 */
function syncRuntimeFrom(profile) {
  const c = profileConfig(profile);
  llmRuntime = {
    provider: c.provider, apiKey: c.apiKey, baseURL: c.baseURL, model: c.model,
    temperature: c.temperature, maxTokens: c.maxTokens, timeoutMs: c.timeoutMs,
  };
  llmState.tested = false;
  llmState.lastError = '';
}
if (vault.getDefault()) syncRuntimeFrom(vault.getDefault());

/* ---------------- 局内短期反馈：上回合动作 → 结果 Δ ---------------- */

const blankFeedback = () => Object.fromEntries(AI_IDS.map(ai => [ai, '']));
let turnFeedback = blankFeedback();

function metricsFor(game, ai) {
  return {
    territory: game.territoryCount[ai],
    units: aliveCount(game, ai),
    stock: game.stock[ai],
    kills: game.kills[ai],
    baseHp: game.bases[ai].hp,
  };
}

/** 只挑跟本家有关的事件（「A03 阵亡」算 A 的，「ABCD」不算） */
function eventsFor(events, ai) {
  const re = new RegExp(`(^|[^A-Z])${ai}([^A-Z]|$)`);
  return (events || []).filter(e => re.test(e)).slice(0, 3);
}

const snapshot = () => (activeGame ? publicSnapshot(activeGame) : null);
const broadcast = () => { const s = snapshot(); if (s) io.emit('state', s); };
const llmConfig = () => resolveConfig(llmRuntime);

function assignmentFromControllers() {
  return Object.fromEntries(AI_IDS.map((ai, i) => [
    ai, controllers[ai].mode === 'llm' ? 'llm' : strategyForAI(controllers, ai, i),
  ]));
}

/** 势力当前实际使用的模型名（排行榜 / 状态用） */
function modelLabelFor(ctl) {
  if (ctl.mode !== 'llm') return '';
  const p = ctl.profileId ? vault.get(ctl.profileId) : vault.getDefault();
  return p ? displayName(p) : (llmConfig().model || llmConfig().presetLabel);
}

/** 势力本回合该用哪份配置；返回 null 表示要降级为脚本 */
function configForController(ctl) {
  // 没指定 profileId 时优先用「默认模型」（与界面标记一致），没有模型库才回落到旧版通用配置 / .env
  const p = ctl.profileId ? vault.get(ctl.profileId) : vault.getDefault();
  if (ctl.profileId && !p) return { conf: null, label: '', reason: '所选模型已删除，已用自动策略代打' };
  if (p) {
    const conf = resolveConfig(profileConfig(p));
    const label = displayName(p);
    if (!conf.hasKey) return { conf: null, label, reason: '该模型未配置 API Key，已用自动策略代打' };
    if (!conf.baseURL || !conf.model) return { conf: null, label, reason: '该模型缺端点或模型名，已用自动策略代打' };
    return { conf, label, reason: '' };
  }
  const c = llmConfig();
  return { conf: c.hasKey ? c : null, label: c.model || c.presetLabel, reason: '未配置 API Key，已用自动策略代打' };
}

/** 对外可见的 LLM 状态：不含明文 Key */
function llmPublic() {
  const c = llmConfig();
  return {
    provider: c.provider,
    providerLabel: c.presetLabel,
    protocol: c.protocol,
    baseURL: c.baseURL,
    model: c.model,
    hasKey: c.hasKey,
    keySource: c.source,
    keyMask: maskKey(c.apiKey),
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    timeoutMs: c.timeoutMs,
    tested: llmState.tested,
    lastError: llmState.lastError,
    lastOkAt: llmState.lastOkAt,
    perAI: llmState.perAI,
    profiles: vault.list(),
    defaultProfileId: vault.defaultId,
  };
}

/* ---------------- 局末结算：战绩落盘 + 复盘经验（跨重启保留） ---------------- */

function recordResult(game) {
  if (recordedSerial === gameSerial || !game.over) return;
  recordedSerial = gameSerial;
  const modelLabels = Object.fromEntries(AI_IDS.map(ai => [ai, modelLabelFor(controllers[ai])]));
  const match = memory.record(game, { serial: gameSerial, controllers, modelLabels });
  lastResult = {
    winner: game.winner, winType: game.winType, turn: game.turn,
    serial: gameSerial, matchId: match.id,
  };
}

/* ---------------- 回合驱动 ---------------- */

function applyControllers(raw) {
  controllers = normalizeControllers(raw, VALID_STRATEGIES, new Set(vault.items.map(p => p.id)));
  assignment = assignmentFromControllers();
  llmState.perAI = freshPerAI();
}

function startGame({ seed, cfg, turns, strategies, controllers: ctrl } = {}) {
  stopAuto();
  if (ctrl !== undefined) applyControllers(ctrl);
  else if (Array.isArray(strategies) && strategies.length) applyControllers(strategies);

  const merged = normalizeCfg({ ...activeCfg, ...(cfg || {}), ...(turns != null ? { turns } : {}) });
  activeCfg = merged;
  activeGame = createGame(seed, { cfg: merged });
  gameSerial++;
  llmState.lastError = '';
  llmState.perAI = freshPerAI();
  turnFeedback = blankFeedback();
  memory.beginMatch();
  broadcast();
  return activeGame;
}

/** 一回合：脚本势力同步产出动作，LLM 势力并发请求，失败则本回合降级为脚本 */
async function tick() {
  if (!activeGame || activeGame.over || ticking) return false;
  ticking = true;
  const game = activeGame;
  const nextTurn = game.turn + 1;
  // 回合前快照：resolveTurn 之后算出「上回合做了什么 → 得到什么」
  const before = Object.fromEntries(AI_IDS.map(ai => [ai, metricsFor(game, ai)]));

  try {
    const jobs = AI_IDS.map(async (ai, i) => {
      if (!factionAlive(game, ai)) return [ai, []];
      const ctl = controllers[ai];
      const view = getViewFor(game, ai);
      const fallback = () => (STRATEGIES[strategyForAI(controllers, ai, i)] || STRATEGIES.economist)
        .buildActions(view, game, ai);

      if (ctl.mode !== 'llm') {
        llmState.perAI[ai] = { state: 'bot', at: nextTurn };
        return [ai, fallback()];
      }
      // 每家独立解析配置：选了不同模型就用不同的 Key / 端点
      const { conf, label, reason } = configForController(ctl);
      if (!conf) {
        llmState.perAI[ai] = { state: 'nokey', at: nextTurn, model: label, error: reason };
        logLLMTrace({ turn: nextTurn, ai, model: label, state: 'nokey', error: reason });
        return [ai, fallback()];
      }

      const t0 = Date.now();
      let detail = null;
      try {
        // 三层记忆：局内上回合 Δ + 跨局胜率/败因 + 局末复盘经验
        const recall = memory.recall(ai, turnFeedback[ai]);
        const prompt = buildPrompt(view, styleFor(ctl.strategy), recall);
        detail = await askLLMDetailed(prompt, conf);
        const parsed = extractJSON(detail.text);
        const ms = detail.ms;
        llmState.lastOkAt = Date.now();
        llmState.lastError = '';
        if (parsed) {
          const note = typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 120) : '';
          const acts = sanitizeActions(parsed.actions, view, ai);
          llmState.perAI[ai] = { state: 'ok', at: nextTurn, ms, model: label, note };
          // 思维过程 + 最终动作同步落盘（logs/llm-YYYY-MM-DD.log）
          logLLMTrace({
            turn: nextTurn, ai, model: label, provider: detail.provider, ms,
            state: 'ok', note, thinking: detail.reasoning,
            raw: detail.text, actions: acts, rejected: view.lastRejected?.[ai],
          });
          return [ai, acts];
        }
        llmState.perAI[ai] = { state: 'parse', at: nextTurn, ms, model: label, error: '输出不是合法 JSON，已降级' };
        logLLMTrace({
          turn: nextTurn, ai, model: label, provider: detail.provider, ms,
          state: 'parse', thinking: detail.reasoning, error: '输出不是合法 JSON，已降级',
          raw: detail.text, rejected: view.lastRejected?.[ai],
        });
      } catch (e) {
        const ms = Date.now() - t0;
        llmState.perAI[ai] = { state: 'error', at: nextTurn, ms, model: label, error: e.message };
        llmState.lastError = e.message;
        logLLMTrace({
          turn: nextTurn, ai, model: label, provider: detail?.provider || '', ms,
          state: 'error', error: e.message, thinking: detail?.reasoning || '',
          raw: detail?.text || '', rejected: view.lastRejected?.[ai],
        });
      }
      return [ai, fallback()];
    });

    const actionsByAI = Object.fromEntries(await Promise.all(jobs));
    resolveTurn(game, actionsByAI);
    for (const ai of AI_IDS) {
      turnFeedback[ai] = buildFeedback(
        before[ai], metricsFor(game, ai), actionsByAI[ai], eventsFor(game.events, ai)
      );
    }
    recordResult(game);
    return true;
  } catch (e) {
    // 裁判/记账/广播任一抛错都不能让 Promise 逃逸：/api/step 会挂起，
    // 自动运行的 setTimeout 链会变成未处理 rejection 直接终止进程。
    console.error('[turn] 回合结算失败：', e?.stack || e);
    llmState.lastError = `回合结算失败：${e.message}`;
    return false;
  } finally {
    ticking = false;
  }
}

/* ---------------- 自动运行（异步自调度，不会与 LLM 请求重叠） ---------------- */

function stopAuto() {
  autoRunning = false;
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function startAuto(interval) {
  stopAuto();
  autoRunning = true;
  const delay = Math.max(50, Number(interval) || 700);
  const loop = async () => {
    if (!autoRunning) return;
    if (!activeGame || activeGame.over) {
      autoRunning = false; autoTimer = null; broadcast(); return;
    }
    try {
      await tick();
      if (!autoRunning) return;
      broadcast();
      if (!activeGame || activeGame.over) { autoRunning = false; autoTimer = null; return; }
      autoTimer = setTimeout(loop, delay);
    } catch (e) {
      console.error('[auto] 自动运行已中断：', e?.stack || e);
      autoRunning = false; autoTimer = null;
    }
  };
  autoTimer = setTimeout(loop, 0);
}

/* ---------------- 本机 .env 持久化 ---------------- */

const ENV_FILE = path.join(__dirname, '../.env');

function persistEnv(conf) {
  let txt = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const upsert = (k, v) => {
    const re = new RegExp(`^\\s*${k}\\s*=.*$`, 'm');
    const line = `${k}=${v}`;
    txt = re.test(txt) ? txt.replace(re, line) : `${txt.replace(/\s*$/, '')}\n${line}\n`;
  };
  if (conf.protocol === 'anthropic') {
    upsert('ANTHROPIC_BASE_URL', conf.baseURL);
    upsert('ANTHROPIC_MODEL', conf.model);
    if (conf.hasKey) upsert('ANTHROPIC_API_KEY', conf.apiKey);
  } else {
    upsert('OPENAI_BASE_URL', conf.baseURL);
    upsert('OPENAI_MODEL', conf.model);
    if (conf.hasKey) upsert('OPENAI_API_KEY', conf.apiKey);
  }
  fs.writeFileSync(ENV_FILE, txt, 'utf8');
  // 同步进程内 env，让 env 兜底与面板状态一致（重启后由 dotenv 读回）
  process.env.OPENAI_BASE_URL = conf.baseURL;
  process.env.OPENAI_MODEL = conf.model;
  if (conf.hasKey) process.env.OPENAI_API_KEY = conf.apiKey;
}

function clearEnvKey() {
  if (!fs.existsSync(ENV_FILE)) return;
  let txt = fs.readFileSync(ENV_FILE, 'utf8');
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    txt = txt.replace(new RegExp(`^\\s*${k}\\s*=.*$`, 'm'), `${k}=`);
  }
  fs.writeFileSync(ENV_FILE, txt, 'utf8');
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}

/* ---------------- 静态配置 ---------------- */

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    mapW: MAP_W, mapH: MAP_H, cells: CELLS,
    cfg: activeCfg,
    defaults: CFG_DEF,
    limits: CFG_LIMITS,
    labels: CFG_LABEL,
    rules: RULES,
    strategies: VALID_STRATEGIES,
    styles: STYLE_OPTIONS,
    providers: PROVIDER_LIST,
    controllers,
    profiles: vault.list(),
    defaultProfileId: vault.defaultId,
  });
});

app.get('/api/state', (req, res) => res.json({ ok: true, game: snapshot() }));

/* ---------------- 大模型配置 ---------------- */

app.get('/api/llm/config', (req, res) => {
  res.json({ ok: true, ...llmPublic(), presets: PROVIDER_LIST, controllers });
});

// 大模型思维日志：直接吐当天日志文件的末尾若干行，方便不开文件也能看
app.get('/api/llm/log', (req, res) => {
  const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 400));
  const file = currentLogFile();
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = text.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - limit)).join('\n');
    res.json({ ok: true, file, lines: tail });
  } catch (e) {
    res.json({ ok: false, file, error: e.message, lines: '' });
  }
});

app.post('/api/llm/config', (req, res) => {
  const b = req.body || {};
  const prior = llmRuntime.provider;
  const priorURL = normURL(llmRuntime.baseURL);
  if (Object.hasOwn(PROVIDERS, b.provider)) llmRuntime.provider = b.provider;
  // 换服务商时清掉手填值，让新预设自动生效（除非本次显式传了新值）
  if (llmRuntime.provider !== prior) { llmRuntime.baseURL = ''; llmRuntime.model = ''; }

  for (const k of ['baseURL', 'model']) {
    if (typeof b[k] === 'string') llmRuntime[k] = b[k].trim();
  }
  for (const k of ['temperature', 'maxTokens', 'timeoutMs']) {
    if (b[k] !== undefined && b[k] !== '' && Number.isFinite(Number(b[k]))) llmRuntime[k] = Number(b[k]);
  }
  try { assertSafeBaseURL(llmRuntime.baseURL); }
  catch (e) { return res.json({ ok: false, error: e.message, ...llmPublic() }); }

  const hasNewKey = typeof b.apiKey === 'string' && !!b.apiKey.trim();
  const nextURL = normURL(llmRuntime.baseURL);
  // 只有「端点被改到别的自定义地址且没给新 Key」才解绑旧 Key；
  // 编辑同一份配置（只改模型名/温度、Key 留空）必须保留原 Key。
  const customURL = nextURL && nextURL !== priorURL && !PRESET_URLS.has(nextURL);
  if (hasNewKey) {
    llmRuntime.apiKey = b.apiKey.trim();
    llmState.tested = false;
  } else if (customURL) {
    // 换到自定义端点却没给新 Key：清掉旧 Key，避免之后每回合把它发到新地址
    llmRuntime.apiKey = '';
    llmState.tested = false;
  }
  llmState.lastError = '';

  let persisted = false;
  try {
    if (b.persist) { persistEnv(llmConfig()); persisted = true; }
  } catch (e) {
    return res.json({ ok: false, error: `写入 .env 失败：${e.message}`, ...llmPublic() });
  }
  broadcast();
  res.json({ ok: true, persisted, ...llmPublic() });
});

app.post('/api/llm/test', async (req, res) => {
  const b = req.body || {};
  const probe = { ...llmRuntime };
  for (const k of ['apiKey', 'provider', 'baseURL', 'model', 'temperature', 'maxTokens', 'timeoutMs']) {
    if (b[k] !== undefined && b[k] !== '') probe[k] = b[k];
  }
  // 端点被改到别的自定义地址且没显式填 Key：不许继承已保存的 Key / .env 兜底 Key。
  // 测试当前已保存的配置（端点没变）则照常沿用它的 Key。
  const probeURL = normURL(probe.baseURL);
  const savedURL = normURL(llmRuntime.baseURL);
  if (probeURL && probeURL !== savedURL && !PRESET_URLS.has(probeURL) && !String(b.apiKey || '').trim()) {
    probe.apiKey = '';
    probe.strictKey = true;
  }
  try {
    const r = await testLLM(probe);
    llmState.tested = true;
    llmState.lastOkAt = Date.now();
    llmState.lastError = '';
    // 测试用的是刚粘贴、还没保存的 Key？通过即自动收下，省一步操作
    // 多模型面板走 noAutoSave：测试不该悄悄改掉「默认模型」的 Key
    let autoSaved = false;
    if (!b.noAutoSave && typeof b.apiKey === 'string' && b.apiKey.trim() && b.apiKey.trim() !== llmRuntime.apiKey) {
      llmRuntime.apiKey = b.apiKey.trim();
      autoSaved = true;
      try { if (b.persist) persistEnv(llmConfig()); } catch { /* 不阻断测试 */ }
    }
    broadcast();
    res.json({ ok: true, ...r, autoSaved, ...llmPublic() });
  } catch (e) {
    llmState.tested = false;
    llmState.lastError = e.message;
    broadcast();
    res.json({ ok: false, error: e.message, ...llmPublic() });
  }
});

app.post('/api/llm/clear', (req, res) => {
  llmRuntime.apiKey = '';
  llmState.tested = false;
  llmState.lastError = '';
  try { clearEnvKey(); } catch (e) { console.error('[llm] clear .env:', e.message); }
  broadcast();
  res.json({ ok: true, ...llmPublic() });
});

/* ---------------- 多模型配置：保存 / 测试 / 删除 / 设为默认 ---------------- */
/* 明文 Key 只进 vault 与本机 data/llm-profiles.json；返回体一律 llmPublic() 脱敏 */

app.post('/api/llm/profiles', (req, res) => {
  const b = req.body || {};
  try {
    assertSafeBaseURL(b.baseURL);
    const hadDefault = !!vault.getDefault();
    const p = vault.upsert(b);
    const makeDefault = b.makeDefault === true || !hadDefault;
    if (makeDefault) vault.setDefault(p.id);
    // 改的就是当前默认模型 → 立刻同步到通用配置，保证「AI 大模型（默认）」跟着变
    if (vault.defaultId === p.id) syncRuntimeFrom(p);

    let persisted = false;
    if (b.persist && vault.defaultId === p.id) {
      persistEnv(resolveConfig(profileConfig(p)));
      persisted = true;
    }
    broadcast();
    res.json({
      ok: true, madeDefault: makeDefault, persisted,
      profile: publicProfile(p, vault.defaultId), ...llmPublic(),
    });
  } catch (e) {
    res.json({ ok: false, error: `保存模型失败：${e.message}`, ...llmPublic() });
  }
});

app.post('/api/llm/profiles/test', async (req, res) => {
  const b = req.body || {};
  const p = vault.get(String(b.id || ''));
  if (!p) return res.json({ ok: false, error: '该模型不存在或已被删除', ...llmPublic() });
  const probe = profileConfig(p);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) probe.apiKey = b.apiKey.trim();
  try {
    const r = await testLLM(probe);
    vault.markTested(p.id);
    llmState.tested = true;
    llmState.lastOkAt = Date.now();
    llmState.lastError = '';
    broadcast();
    res.json({ ok: true, ...r, ...llmPublic() });
  } catch (e) {
    llmState.lastError = e.message;
    broadcast();
    res.json({ ok: false, error: e.message, ...llmPublic() });
  }
});

app.post('/api/llm/profiles/default', (req, res) => {
  const p = vault.setDefault(String(req.body?.id || ''));
  if (!p) return res.json({ ok: false, error: '该模型不存在或已被删除', ...llmPublic() });
  syncRuntimeFrom(p);
  broadcast();
  res.json({ ok: true, ...llmPublic() });
});

app.post('/api/llm/profiles/delete', (req, res) => {
  const id = String(req.body?.id || '');
  const wasDefault = vault.defaultId === id;
  const p = vault.remove(id);
  if (!p) return res.json({ ok: false, error: '该模型不存在或已被删除', ...llmPublic() });
  if (wasDefault) {
    const next = vault.getDefault();
    if (next) syncRuntimeFrom(next);
    else { llmRuntime.apiKey = ''; llmState.tested = false; }
  }
  // 引用了被删模型的势力去掉 profileId：退回默认模型，不会卡在失效引用上
  if (wasDefault || AI_IDS.some(ai => controllers[ai].profileId === id)) applyControllers(controllers);
  broadcast();
  res.json({ ok: true, removed: displayName(p), ...llmPublic() });
});

/* ---------------- 势力操控 ---------------- */

app.get('/api/controllers', (req, res) => res.json({ ok: true, controllers, assignment }));

app.post('/api/controllers', (req, res) => {
  applyControllers(req.body?.controllers ?? req.body);
  broadcast();
  res.json({ ok: true, controllers, assignment });
});

/* ---------------- 对局记忆：战绩 / 经验 / 大模型复盘 ---------------- */

app.get('/api/memory', (req, res) => res.json({ ok: true, ...memory.publicView() }));

app.post('/api/memory/config', (req, res) => {
  memory.setConfig(req.body || {});
  broadcast();
  res.json({ ok: true, ...memory.publicView() });
});

app.post('/api/memory/clear', (req, res) => {
  memory.clear();
  broadcast();
  res.json({ ok: true, ...memory.publicView() });
});

app.post('/api/memory/lesson', (req, res) => {
  const b = req.body || {};
  const ai = String(b.ai || '').toUpperCase();
  if (b.action === 'remove') {
    const removed = memory.removeLesson(ai, String(b.id || ''));
    broadcast();
    return res.json({ ok: removed, ...memory.publicView() });
  }
  const l = memory.addLesson(ai, b.text, 'manual');
  broadcast();
  res.json({ ok: !!l, ...memory.publicView() });
});

/** 手动触发：把上一局数据交给大模型复盘，产出 1~3 条可执行的经验 */
app.post('/api/memory/reflect', async (req, res) => {
  const b = req.body || {};
  const match = memory.lastMatch();
  if (!match) return res.json({ ok: false, error: '还没有已结束的对局可复盘', ...memory.publicView() });
  const want = String(b.ai || '').toUpperCase();
  const target = AI_IDS.includes(want) ? want
    : (AI_IDS.find(x => match.perAI[x].mode === 'llm') || 'A');
  const ctl = { mode: 'llm', profileId: b.profileId ? String(b.profileId) : (controllers[target].profileId || null) };
  const { conf, label, reason } = configForController(ctl);
  if (!conf) return res.json({ ok: false, error: `无法复盘：${reason}`, ...memory.publicView() });

  try {
    const detail = await askLLMDetailed(buildReflectPrompt(match, target), {
      ...conf, maxTokens: Math.max(400, Number(conf.maxTokens) || 400),
    });
    const parsed = extractJSON(detail.text);
    const list = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    const added = [];
    for (const t of list.slice(0, 3)) {
      const l = memory.addLesson(target, String(t), 'llm', match.id);
      if (l) added.push(l.text);
    }
    logLLMTrace({
      turn: match.turns ?? 0, ai: target, model: label, provider: detail.provider, ms: detail.ms,
      state: 'ok', thinking: detail.reasoning, raw: detail.text, actions: added, source: 'reflect',
    });
    llmState.lastOkAt = Date.now();
    llmState.lastError = '';
    broadcast();
    res.json({ ok: added.length > 0, ai: target, model: label, added, ...memory.publicView() });
  } catch (e) {
    llmState.lastError = e.message;
    res.json({ ok: false, error: `复盘失败：${e.message}`, ...memory.publicView() });
  }
});

/* ---------------- 对局 ---------------- */

app.post('/api/new', (req, res) => {
  const { seed = Date.now() % 1e9, turns, cfg, strategies, controllers: ctrl } = req.body || {};
  const game = startGame({ seed, cfg, turns, strategies, controllers: ctrl });
  res.json({ ok: true, seed, cfg: game.cfg, game: snapshot() });
});

app.post('/api/step', async (req, res) => {
  if (!activeGame) return res.status(400).json({ error: 'not started' });
  if (activeGame.over) return res.status(400).json({ error: 'game over' });
  stopAuto();
  try {
    await tick();
    broadcast();
    res.json({ ok: true, game: snapshot() });
  } catch (e) {
    console.error('[step] 单步失败：', e?.stack || e);
    res.json({ ok: false, error: `单步失败：${e.message}`, game: snapshot() });
  }
});

app.post('/api/auto', (req, res) => {
  const {
    interval = 700, seed = Date.now() % 1e9, turns, cfg, strategies, controllers: ctrl,
  } = req.body || {};
  const game = startGame({ seed, cfg, turns, strategies, controllers: ctrl });
  startAuto(interval);
  res.json({ ok: true, mode: 'auto', seed, cfg: game.cfg });
});

app.post('/api/stop', (req, res) => {
  stopAuto();
  res.json({ ok: true });
});

/** 兼容旧接口：四家全部交给大模型并自动开跑 */
app.post('/api/llm-game', (req, res) => {
  const { seed = Date.now() % 1e9, turns, cfg, interval = 700 } = req.body || {};
  const allLLM = Object.fromEntries(AI_IDS.map(ai => [ai, { mode: 'llm', strategy: 'auto' }]));
  const game = startGame({ seed, cfg, turns, controllers: allLLM });
  startAuto(interval);
  res.json({ ok: true, mode: 'llm', seed, cfg: game.cfg });
});

/* ---------------- 快照 ---------------- */

function publicSnapshot(game) {
  const cfg = game.cfg;
  const rank = displayRanking(game);
  const leaderboard = rank.map((ai, i) => ({
    rank: i + 1,
    ai,
    territory: game.territoryCount[ai],
    pct: +(game.territoryCount[ai] / CELLS * 100).toFixed(1),
    units: aliveCount(game, ai),
    stock: game.stock[ai],
    kills: game.kills[ai],
    score: game.scores[ai],
    baseHp: game.bases[ai].hp,
    baseMaxHp: game.bases[ai].maxHp,
    alive: factionAlive(game, ai),
    mode: controllers[ai].mode,
    strategy: controllers[ai].strategy,
    profileId: controllers[ai].profileId || null,
    model: modelLabelFor(controllers[ai]),
    winRate: memory.stats(ai).winRate,
    llm: llmState.perAI[ai] || { state: 'idle' },
  }));

  return {
    turn: game.turn,
    maxTurns: game.maxTurns,
    mapW: MAP_W,
    mapH: MAP_H,
    cells: CELLS,
    over: game.over,
    winner: game.winner || null,
    winType: game.winType || null,
    events: game.events,
    cfg,
    assignment,
    controllers,
    leaderboard,
    records: memory.recordsView(),
    memory: memory.publicView(),
    feedback: { ...turnFeedback },
    lastResult,
    llm: llmPublic(),
    territoryCount: game.territoryCount,
    territoryGain: game.territoryGain || Object.fromEntries(AI_IDS.map(a => [a, 0])),
    territory: encodeTerritory(game),
    scores: game.scores,
    kills: game.kills,
    stock: game.stock,
    alive: Object.fromEntries(AI_IDS.map(a => [a, aliveCount(game, a)])),
    hasBase: Object.fromEntries(AI_IDS.map(a => [a, factionAlive(game, a)])),
    bases: Object.fromEntries(AI_IDS.map(a => [a, {
      x: game.bases[a].x, y: game.bases[a].y,
      alive: game.bases[a].alive,
      hp: game.bases[a].hp, maxHp: game.bases[a].maxHp,
    }])),
    ranking: rank,
    units: game.units.filter(u => u.alive).map(u => ({
      id: u.id, owner: u.owner, x: u.x, y: u.y,
      hp: u.hp,
      maxHp: maxHpAt(game, u.owner, u.x, u.y),
      atk: attackOf(game, u),
      spring: u.spring,
      dist: Math.max(Math.abs(u.x - game.bases[u.owner].x), Math.abs(u.y - game.bases[u.owner].y)),
    })),
    resources: game.resources.map(r => ({
      type: r.type, x: r.x, y: r.y, stock: r.stock, claimedBy: r.claimedBy,
    })),
    wallCount: game.wallCount,
    goldMine: {
      x: game.goldMine.x, y: game.goldMine.y,
      owner: game.goldMine.owner,
      yield: game.cfg.goldYield,
      produced: game.goldMine.produced,
    },
    // 图表与「本回合变化」直接吃这份逐回合快照（最多 160 点）
    history: game.history.slice(-160).map(h => ({
      turn: h.turn,
      territory: h.territory,
      units: h.units,
      stock: h.stock,
      kills: h.kills,
      scores: h.scores,
      gain: h.gain,
      events: h.events,
    })),
  };
}

/* ---------------- 全局兜底 ---------------- */

// Express 4 默认会给畸形 JSON / 请求体过大返回带堆栈的 HTML，前端 api() 解析不了。
// 统一成 {ok:false,error}，并保证任何漏出的异常不会挂起请求。
app.use((err, req, res, next) => {
  console.error('[http]', req.method, req.path, err?.message || err);
  if (res.headersSent) return next(err);
  const code = Number(err?.status || err?.statusCode) || 400;
  res.status(code).json({ ok: false, error: err?.message || '请求处理失败' });
});

process.on('unhandledRejection', reason => {
  console.error('[process] 未处理的 Promise 拒绝：', reason?.stack || reason);
});
process.on('uncaughtException', e => {
  // 本机单机服务：记录后保持进程可用，别让一次意外把整局丢掉
  console.error('[process] 未捕获异常（已记录，服务继续）：', e?.stack || e);
});

io.on('connection', socket => {
  if (activeGame) socket.emit('state', publicSnapshot(activeGame));
});

const PORT = process.env.PORT || 3000;
// 默认只监听本机：服务没有鉴权，别把改端点 / 开局 / 清记忆的接口暴露到局域网。
// 确实需要外部访问时显式设 HOST=0.0.0.0。
const HOST = process.env.HOST || '127.0.0.1';
httpServer.listen(PORT, HOST, () => {
  console.log(`Border Colony v6.4 at http://${HOST}:${PORT}`);
  // 每次服务启动都强制回到「刚点新开一局」的初始状态：T0 棋盘、固定初始布局、
  // 空的回合反馈与模型状态、无自动运行。以前 activeGame=null 会让页面只剩空棋盘。
  // 固定 seed 保证每次启动的泉水 / 资源点 / 基地布局完全一致，便于对照实验。
  // AUTO_START=0 可关闭自动开局；AUTO_START_SEED=<数字> 可换初始布局。
  if (process.env.AUTO_START !== '0') {
    try {
      const seed = Number(process.env.AUTO_START_SEED) || 20261106;
      stopAuto();
      lastResult = null;
      turnFeedback = blankFeedback();
      llmState.lastError = '';
      llmState.lastOkAt = null;
      llmState.tested = false;
      llmState.perAI = freshPerAI();
      startGame({ seed });
      console.log(`[boot] 初始棋盘已就绪 T0/${activeGame.cfg.turns} (seed=${seed})；AUTO_START=0 可关闭`);
    } catch (e) {
      console.error('[boot] 初始棋盘创建失败：', e.message);
    }
  }
});
