// server/logger.js — 追加式运行日志（v6.5 / v6.7）
// 目的：把大模型的「思维过程」（reasoning_content / thinking 块）、原始输出、清洗后动作
//       以及上一回合被裁判丢弃的动作数同步落盘到 logs/llm-YYYY-MM-DD.log，同时镜像一行到控制台。
// 写法约定：appendFileSync，一条记录一次性写入，避免并发回合互相覆盖；
//           任何日志异常都吞掉，绝不影响对局本身。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(ROOT, 'logs');

const pad = n => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dayFile(d = new Date()) {
  return path.join(LOG_DIR, `llm-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}

function clip(text, max) {
  const t = String(text ?? '').replace(/\r/g, '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…（原文 ${t.length} 字，已截断）`;
}

/** 多行文本按行加前缀，保留模型自己的分段 */
function block(label, text, max) {
  const t = clip(text, max);
  if (!t) return [];
  return t.split('\n').map(line => `  ${label}: ${line}`);
}

/**
 * 记录一次大模型调用。
 * @param {object} rec
 * @param {number} rec.turn      回合号
 * @param {string} rec.ai        势力 A/B/C/D
 * @param {string} [rec.model]   模型名（脱敏后的 label）
 * @param {string} [rec.provider]服务商标识
 * @param {number} [rec.ms]      耗时
 * @param {string} rec.state     ok / parse / error / nokey
 * @param {string} [rec.note]    模型自述的一句话决策依据
 * @param {string} [rec.thinking]思维过程（reasoning_content / thinking）
 * @param {string} [rec.raw]     模型原始输出（清洗前，便于排查被丢弃的动作）
 * @param {*} [rec.actions]      清洗后实际提交给裁判的动作
 * @param {object} [rec.rejected]上一回合该势力被裁判丢弃 / 阻挡的动作数
 * @param {string} [rec.error]   失败原因
 * @param {string} [rec.source]  触发来源：web / cli / reflect
 */
export function logLLMTrace(rec = {}) {
  const {
    turn = 0, ai = '?', model = '-', provider = '', ms = 0,
    state = 'ok', note = '', thinking = '', raw = '', actions = null,
    rejected = null, error = '', source = 'web',
  } = rec;

  const head = `[${stamp()}] T${String(turn).padStart(3, '0')} ${ai} `
    + `${provider ? `${provider}/` : ''}${model} ${ms}ms ${state}${source !== 'web' ? ` (${source})` : ''}`;

  const lines = [head];
  if (error) lines.push(`  error: ${clip(error, 400)}`);
  if (rejected) lines.push(`  lastRejected: ${clip(JSON.stringify(rejected), 300)}`);
  lines.push(...block('note', note, 400));
  lines.push(...block('thinking', thinking, 8000));
  if (raw) lines.push(`  raw: ${clip(String(raw).replace(/\s*\n\s*/g, ' '), 4000)}`);
  if (actions) {
    let dumped = '';
    try { dumped = JSON.stringify(actions); } catch { dumped = '[无法序列化]'; }
    lines.push(`  actions: ${clip(dumped, 1200)}`);
  }
  lines.push('');

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(dayFile(), `${lines.join('\n')}\n`, 'utf8');
  } catch { /* 日志写不进去也不能影响对局 */ }

  // 控制台镜像：只在有思考内容时多打一行，避免刷屏
  const brief = thinking ? ` · 思考 ${clip(thinking.replace(/\s+/g, ' '), 160)}` : '';
  const tag = state === 'ok' ? '[llm]' : `[llm:${state}]`;
  const line = `${tag} T${turn} ${ai} ${model} ${ms}ms${error ? ` 错误=${clip(error, 120)}` : ''}${brief}`;
  if (state === 'ok') console.log(line);
  else console.warn(line);

  return head;
}

/** 当前日志文件路径（给接口 / 自检用） */
export function currentLogFile() {
  return dayFile();
}
