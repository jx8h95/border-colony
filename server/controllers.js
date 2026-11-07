// server/controllers.js — 势力操控模式（v6.2）
// 每个势力在开局前可选「AI 大模型」或「自动策略」，并各自指定打法风格。
// 纯函数，方便单测；服务端与前端共用同一套 key。
import { AI_IDS } from './engine.js';

/** 四家默认打法（保持 v6.1 的四种风格分布） */
export const DEFAULT_STRATEGIES = ['aggressive', 'economist', 'fortress', 'turtle'];

/** 打法选项：auto = 大模型自主决策 / 脚本按位置取默认打法 */
export const STYLE_OPTIONS = [
  { key: 'auto', label: '默认 / 自主', botLabel: '默认打法', llmLabel: '自主决策' },
  { key: 'aggressive', label: '侵略者' },
  { key: 'economist', label: '经济人' },
  { key: 'fortress', label: '要塞家' },
  { key: 'turtle', label: '龟缩者' },
];

const DEFAULT_CONTROLLERS = () => Object.fromEntries(
  AI_IDS.map((ai, i) => [ai, { mode: 'bot', strategy: DEFAULT_STRATEGIES[i] }])
);

/**
 * 归一化操控配置。
 * 支持三种写法：
 *   ['aggressive','economist','fortress','turtle']            旧版策略数组
 *   { A:'llm', B:{mode:'bot',strategy:'turtle'} }             简写 / 完整对象
 *   { A:{mode:'llm',strategy:'auto',profileId:'m_ab12'} }     大模型 + 指定已保存的模型 Key
 * @param {*} raw
 * @param {string[]} validStrategies 可用脚本策略 key
 * @param {Set<string>} validProfileIds 现存模型 id（传了才校验，未传表示不过滤）
 */
export function normalizeControllers(raw, validStrategies = DEFAULT_STRATEGIES, validProfileIds = null) {
  const valid = new Set(validStrategies);
  const out = DEFAULT_CONTROLLERS();

  AI_IDS.forEach((ai, i) => {
    const v = Array.isArray(raw) ? raw[i] : (raw && typeof raw === 'object' ? raw[ai] : undefined);
    let mode = 'bot';
    let strategy = DEFAULT_STRATEGIES[i];
    let profileId = null;

    if (typeof v === 'string') {
      const s = v.trim();
      if (['llm', 'ai', 'model', '大模型'].includes(s.toLowerCase())) { mode = 'llm'; strategy = 'auto'; }
      else if (s.startsWith('llm:')) {
        mode = 'llm';
        strategy = valid.has(s.slice(4)) ? s.slice(4) : 'auto';
      } else if (valid.has(s)) strategy = s;
    } else if (v && typeof v === 'object') {
      if (v.mode === 'llm' || v.mode === 'ai') mode = 'llm';
      if (v.strategy === 'auto') strategy = 'auto';
      else if (valid.has(v.strategy)) strategy = v.strategy;
      else if (mode === 'llm') strategy = 'auto';   // 没指定风格就交给模型自主决策
      if (typeof v.profileId === 'string' && v.profileId.trim()) profileId = v.profileId.trim().slice(0, 40);
    }

    // 大模型模式下允许 auto（无风格提示）；脚本模式下 auto 落到该位置的默认打法
    if (strategy === 'auto' && mode === 'bot') strategy = DEFAULT_STRATEGIES[i];
    out[ai] = { mode, strategy };
    // 只有大模型 + 确实存在的模型才带上 profileId，保证旧接口的返回结构不变
    if (mode === 'llm' && profileId && (!validProfileIds || validProfileIds.has(profileId))) {
      out[ai].profileId = profileId;
    }
  });

  return out;
}

/** 脚本策略 key：auto 时按势力位置取默认 */
export function strategyForAI(controllers, ai, i) {
  const s = controllers?.[ai]?.strategy;
  return s && s !== 'auto' ? s : DEFAULT_STRATEGIES[i % DEFAULT_STRATEGIES.length];
}

export { DEFAULT_CONTROLLERS };
