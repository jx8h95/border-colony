// server/llm.js — 大模型接入层（v6.2）
// 零 SDK 依赖：用 Node 原生 fetch 直连 OpenAI 兼容端点 / Anthropic 原生端点。
// 用户只需要提供 API Key；服务商预设会自动带上 Base URL 与模型名。
// 密钥只在服务端内存（可选写入本机 .env），任何接口都不会把明文回传给前端。
import 'dotenv/config';

/** 服务商预设：选一个 + 填 Key 即可开跑 */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI', protocol: 'openai',
    baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek', protocol: 'openai',
    baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
  },
  qwen: {
    label: '通义千问', protocol: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
  },
  zhipu: {
    label: '智谱 GLM', protocol: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
  },
  moonshot: {
    label: 'Moonshot', protocol: 'openai',
    baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
  },
  anthropic: {
    label: 'Anthropic', protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5-20250929',
  },
  custom: {
    label: '自定义端点', protocol: 'openai',
    baseURL: '', model: '',
  },
};

const isPlaceholder = k => !k || /^(sk-\.\.\.|sk-ant-\.\.\.|your[_-]?key|xxx|<.*>)/i.test(k.trim());

/**
 * 把「面板里填的运行时配置」+「预设」+「环境变量」合成一份完整请求配置。
 * 优先级：运行时 > 服务商预设 > 环境变量兜底。
 * runtime.strictKey = true 时完全忽略 .env（多模型配置用，避免 A 家的 Key 串到 B 家）。
 */
export function resolveConfig(runtime = {}) {
  const r = runtime || {};
  const strict = r.strictKey === true;
  const provider = Object.hasOwn(PROVIDERS, r.provider) ? r.provider : 'openai';
  const preset = PROVIDERS[provider];
  const protocol = r.protocol === 'anthropic' || preset.protocol === 'anthropic' ? 'anthropic' : 'openai';

  const envKey = strict ? '' : (protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
  const apiKey = String(r.apiKey ?? '').trim() || String(envKey ?? '').trim();
  const source = String(r.apiKey ?? '').trim() ? 'runtime' : (String(envKey ?? '').trim() ? 'env' : 'none');

  const custom = provider === 'custom';
  // 自定义端点必须显式填端点与模型，不许悄悄回落到环境变量 / OpenAI 官方地址
  let baseURL = String(r.baseURL ?? '').trim();
  if (!baseURL && !custom) {
    baseURL = String(
      (!strict && provider === 'openai' ? process.env.OPENAI_BASE_URL : '') ||
      (!strict && protocol === 'anthropic' ? process.env.ANTHROPIC_BASE_URL : '') ||
      preset.baseURL
    );
  }
  baseURL = baseURL.replace(/\/+$/, '');

  let model = String(r.model ?? '').trim();
  if (!model && !custom) {
    model = String(
      (!strict && provider === 'openai' ? process.env.OPENAI_MODEL : '') ||
      (!strict && protocol === 'anthropic' ? process.env.ANTHROPIC_MODEL : '') ||
      preset.model
    ).trim();
  }

  const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  return {
    provider, protocol, presetLabel: preset.label,
    apiKey, source, hasKey: !isPlaceholder(apiKey),
    baseURL, model,
    temperature: num(r.temperature, 0.7, 0, 2),
    maxTokens: Math.round(num(r.maxTokens, 1200, 16, 8192)),
    timeoutMs: Math.round(num(r.timeoutMs, 25000, 3000, 120000)),
  };
}

/** 密钥脱敏：只保留开头 3 位和末尾 4 位 */
export function maskKey(key) {
  const k = String(key || '').trim();
  if (!k || isPlaceholder(k)) return '';
  if (k.length <= 9) return '••••••••';
  return `${k.slice(0, 3)}••••${k.slice(-4)}`;
}

/* ---------------- 端点安全校验（防 Key 外带 / SSRF） ---------------- */
// 默认只允许 https 公网端点与 http 本机端点（Ollama / 本地 vLLM / 测试 mock）。
// 局域网自建服务可设 LLM_ALLOW_PRIVATE_ENDPOINTS=1 放行。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);
const hostName = u => String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

function isUnsafeHost(host) {
  if (LOOPBACK_HOSTS.has(host)) return false;
  if (host === '0.0.0.0' || host === '::' || host.startsWith('169.254.') || host.startsWith('fe80:')) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function assertSafeBaseURL(raw) {
  const v = String(raw || '').trim();
  if (!v) return;   // 空端点由调用方提示「尚未配置 Base URL」
  let u;
  try { u = new URL(v); } catch { throw new Error('Base URL 不是合法 URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Base URL 只支持 http/https');
  if (u.username || u.password) throw new Error('Base URL 不允许带用户名或密码');

  const host = hostName(u);
  const allowPrivate = process.env.LLM_ALLOW_PRIVATE_ENDPOINTS === '1';
  if (!allowPrivate && isUnsafeHost(host)) throw new Error('Base URL 不允许指向内网 / 云元数据地址');
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(host) && !allowPrivate) {
    throw new Error('http 明文端点只允许本机（127.0.0.1 / localhost），公网请用 https');
  }
}

function shortBody(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 220 ? t.slice(0, 220) + '…' : t;
}

function friendlyNetError(e, timeoutMs) {
  if (e?.name === 'AbortError') return `请求超时（${timeoutMs}ms），可上调超时或换更快的模型`;
  const msg = String(e?.message || e);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return `域名解析失败：${msg}`;
  if (/ECONNREFUSED/i.test(msg)) return `连接被拒绝：${msg}`;
  if (/certificate|SSL|TLS/i.test(msg)) return `证书/SSL 错误：${msg}`;
  return `网络请求失败：${msg}`;
}

/**
 * 提取模型的「思维过程」。
 * - OpenAI 兼容（DeepSeek-R1 / Qwen / GLM 等推理模型）：message.reasoning_content，个别返回 reasoning
 * - Anthropic 扩展思考：content 里 type = thinking 的块
 * 拿不到就返回空串（比如 gpt-4o 这类不暴露推理过程的模型）。
 */
export function extractReasoning(data, isAnthropic = false) {
  if (!data || typeof data !== 'object') return '';
  if (isAnthropic) {
    return (Array.isArray(data.content) ? data.content : [])
      .filter(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))
      .map(b => (typeof b.thinking === 'string' ? b.thinking : '[模型隐藏了这段思考]'))
      .join('\n')
      .trim();
  }
  const msg = data.choices?.[0]?.message || {};
  const r = msg.reasoning_content ?? msg.reasoning ?? msg.reasoning_text;
  return typeof r === 'string' ? r.trim() : '';
}

/**
 * 发一次聊天补全，返回纯文本。
 * @param {string} prompt
 * @param {object} cfg 运行时配置（apiKey / provider / baseURL / model / temperature / maxTokens / timeoutMs）
 * @returns {Promise<string>}
 */
export async function askLLM(prompt, cfg = {}) {
  return (await askLLMDetailed(prompt, cfg)).text;
}

/**
 * 同 askLLM，但把思维过程、模型名、耗时一起返回，供日志层落盘。
 * @returns {Promise<{text:string, reasoning:string, model:string, provider:string, usage:object|null, ms:number}>}
 */
export async function askLLMDetailed(prompt, cfg = {}) {
  const startedAt = Date.now();
  const c = resolveConfig(cfg);
  assertSafeBaseURL(c.baseURL);
  if (!c.hasKey) throw new Error('尚未配置 API Key');
  if (!c.baseURL) throw new Error('尚未配置 Base URL（自定义端点需要手填）');
  if (!c.model) throw new Error('尚未配置模型名');

  const isAnthropic = c.protocol === 'anthropic';
  const url = isAnthropic ? `${c.baseURL}/messages` : `${c.baseURL}/chat/completions`;
  const headers = isAnthropic
    ? { 'content-type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` };
  const body = {
    model: c.model,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let resp, rawText;
  try {
    resp = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    rawText = await resp.text();
  } catch (e) {
    throw new Error(friendlyNetError(e, c.timeoutMs));
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    // 只回显服务商标准错误字段，不把上游原始响应体透出去（可读 SSRF 通道）
    let hint = '';
    try {
      const j = JSON.parse(rawText);
      hint = shortBody(j?.error?.message || j?.message || '');
    } catch { /* 非 JSON 响应体不回显 */ }
    const auth = resp.status === 401 ? '（API Key 无效或不属于该服务商）'
      : resp.status === 403 ? '（权限不足 / 余额不足）'
        : resp.status === 404 ? '（端点或模型名不对，检查 Base URL 与模型）'
          : resp.status === 429 ? '（限流或额度用尽）' : '';
    throw new Error(`HTTP ${resp.status}${auth}${hint ? `：${hint}` : ''}`);
  }

  let data;
  try { data = JSON.parse(rawText); } catch { throw new Error('返回不是 JSON（响应体未回显）'); }

  const text = isAnthropic
    ? (data.content || []).filter(b => b?.type !== 'thinking' && b?.type !== 'redacted_thinking').map(x => x?.text || '').join('')
    : (data.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.reasoning_content ?? '');
  const reasoning = extractReasoning(data, isAnthropic);
  if (!text && !reasoning) {
    const detail = data.error?.message ? shortBody(data.error.message) : '';
    throw new Error(`模型返回空内容${detail ? `：${detail}` : ''}`);
  }
  return {
    text,
    reasoning,
    model: c.model,
    provider: c.provider,
    usage: data.usage || null,
    ms: Date.now() - startedAt,
  };
}

/** 连通性自检：用最短的一次请求验证 Key / 端点 / 模型是否可用 */
export async function testLLM(cfg = {}) {
  const t0 = Date.now();
  const text = await askLLM('只回复两个字：正常', {
    ...cfg, temperature: 0, maxTokens: Math.min(32, resolveConfig(cfg).maxTokens),
  });
  return { ok: true, ms: Date.now() - t0, preview: String(text).trim().slice(0, 40) };
}

/** 从 LLM 输出中稳健提取 JSON（处理 ```json 包裹、前后解释文字） */
export function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
