// server/profiles.js — 多份大模型配置（v6.3）
// 一份「模型」= 名称 + 服务商 + API Key + 端点/模型 + 采样参数。
// 明文 Key 只留在服务端内存与本机 data/llm-profiles.json，任何对前端的输出都经 publicProfile 脱敏。
import { randomUUID } from 'crypto';
import { PROVIDERS, resolveConfig, maskKey } from './llm.js';
import { readJsonSafe, writeJsonAtomic } from './jsonStore.js';

export const MAX_PROFILES = 16;

const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const hasNum = v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

/** 生成交给 askLLM 的配置；strictKey 保证这份配置只用自己那份 Key，不回落到 .env */
export function profileConfig(p) {
  return {
    provider: p.provider,
    apiKey: p.apiKey,
    baseURL: p.baseURL,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    timeoutMs: p.timeoutMs,
    strictKey: true,
  };
}

export function displayName(p) {
  return p?.name || p?.model || PROVIDERS[p?.provider]?.label || '未命名模型';
}

/** 对前端可见的脱敏视图：绝不含 apiKey 明文 */
export function publicProfile(p, defaultId = null) {
  const c = resolveConfig(profileConfig(p));
  return {
    id: p.id,
    name: displayName(p),
    provider: c.provider,
    providerLabel: c.presetLabel,
    protocol: c.protocol,
    baseURL: c.baseURL,
    model: c.model,
    hasKey: c.hasKey,
    keyMask: maskKey(c.apiKey),
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    timeoutMs: c.timeoutMs,
    createdAt: p.createdAt || null,
    testedAt: p.testedAt || null,
    isDefault: p.id === defaultId,
  };
}

/**
 * 归一化一份配置。更新时没传 apiKey 就沿用旧 Key；换了服务商且没传端点/模型就落回新预设。
 * 纯函数，便于单测。
 */
export function normalizeProfile(raw, existing = null) {
  const r = raw || {};
  const wantProvider = clean(r.provider, 40);
  const provider = Object.hasOwn(PROVIDERS, wantProvider)
    ? wantProvider : (existing?.provider || 'openai');
  const changedProvider = !!existing && existing.provider !== provider;

  const cfg = resolveConfig({
    provider,
    apiKey: clean(r.apiKey) || existing?.apiKey || '',
    baseURL: r.baseURL !== undefined ? clean(r.baseURL) : (changedProvider ? '' : (existing?.baseURL || '')),
    model: r.model !== undefined ? clean(r.model) : (changedProvider ? '' : (existing?.model || '')),
    temperature: hasNum(r.temperature) ? Number(r.temperature) : (existing?.temperature ?? 0.7),
    maxTokens: hasNum(r.maxTokens) ? Number(r.maxTokens) : (existing?.maxTokens ?? 1200),
    timeoutMs: hasNum(r.timeoutMs) ? Number(r.timeoutMs) : (existing?.timeoutMs ?? 25000),
    strictKey: true,
  });

  const fallback = `${PROVIDERS[provider].label} · ${cfg.model || '默认模型'}`;
  return {
    id: existing?.id || `m_${randomUUID().slice(0, 8)}`,
    name: clean(r.name, 40) || fallback,
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    createdAt: existing?.createdAt || new Date().toISOString(),
    testedAt: existing?.testedAt || null,
  };
}

/** 本机持久化保存的多模型配置 */
export class ProfileVault {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.defaultId = null;
    this.load();
  }

  load() {
    const data = readJsonSafe(this.file, null);
    try {
      const arr = Array.isArray(data?.profiles) ? data.profiles : [];
      this.items = arr
        .filter(p => p && typeof p === 'object' && typeof p.id === 'string')
        .slice(0, MAX_PROFILES)
        .map(p => ({ ...normalizeProfile(p, null), id: p.id, name: clean(p.name, 40), createdAt: p.createdAt, testedAt: p.testedAt }));
      this.defaultId = typeof data?.defaultId === 'string' ? data.defaultId : null;
      if (!this.get(this.defaultId)) this.defaultId = null;
    } catch (e) {
      // 结构异常（不是 JSON 解析错误）同样不能把服务拖垮，但要留下线索
      console.error('[profiles] 配置结构异常，已按空库启动：', e.message);
      this.items = [];
      this.defaultId = null;
    }
  }

  save() {
    writeJsonAtomic(this.file, {
      version: 1, defaultId: this.defaultId, profiles: this.items,
    });
  }

  get(id) { return this.items.find(p => p.id === id) || null; }
  getDefault() { return this.get(this.defaultId); }
  list() { return this.items.map(p => publicProfile(p, this.defaultId)); }

  /** 新增或更新；返回保存后的完整对象（含明文 Key，仅服务端内部使用） */
  upsert(raw) {
    const existing = clean(raw?.id, 40) ? this.get(clean(raw.id, 40)) : null;
    if (!existing && this.items.length >= MAX_PROFILES) {
      throw new Error(`最多保存 ${MAX_PROFILES} 份模型，请先删除不用的`);
    }
    const p = normalizeProfile(raw, existing);

    // 名称不许撞车，撞了自动加 #2 / #3
    const used = new Set(this.items.filter(x => x.id !== p.id).map(x => x.name));
    if (used.has(p.name)) {
      const base = p.name;
      let n = 2;
      while (used.has(`${base} #${n}`)) n++;
      p.name = `${base} #${n}`;
    }

    if (existing) Object.assign(existing, p);
    else this.items.push(p);
    if (!this.getDefault()) this.defaultId = p.id;
    this.save();
    return existing || p;
  }

  setDefault(id) {
    const p = this.get(clean(id, 40));
    if (!p) return null;
    this.defaultId = p.id;
    this.save();
    return p;
  }

  markTested(id) {
    const p = this.get(clean(id, 40));
    if (!p) return null;
    p.testedAt = new Date().toISOString();
    this.save();
    return p;
  }

  remove(id) {
    const p = this.get(clean(id, 40));
    if (!p) return null;
    this.items = this.items.filter(x => x.id !== p.id);
    if (this.defaultId === p.id) {
      this.defaultId = this.items.length ? this.items[0].id : null;
    }
    this.save();
    return p;
  }
}
