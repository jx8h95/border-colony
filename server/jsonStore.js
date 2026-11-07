// server/jsonStore.js — 本机 JSON 配置的原子写入与可恢复读取
// 配置里含明文 API Key / 跨局战绩，写入中途崩溃或文件损坏都不该被静默清空。
import fs from 'fs';
import path from 'path';

/** 原子写：先写同目录临时文件，再 rename 覆盖，避免留下半截 JSON。 */
export function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / 权限受限时忽略 */ }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

/**
 * 读取 JSON。文件不存在返回 fallback；内容损坏时先改名备份（不删原数据）并告警，
 * 再返回 fallback —— 不再悄悄把用户攒的模型和战绩抹掉。
 */
export function readJsonSafe(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[jsonStore] 读取失败：', file, e.message);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.error(`[jsonStore] 配置损坏，已备份到 ${backup}；本次以空配置启动`);
    } catch (e) {
      console.error('[jsonStore] 损坏文件备份失败：', file, e.message);
    }
    return fallback;
  }
}
