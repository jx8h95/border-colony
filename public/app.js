(() => {
  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('canvasWrap');

  /* 领土层：地图 1 格 = 位图 1 像素，放大时才 drawImage，避免逐格绘制 */
  const terrCanvas = document.createElement('canvas');
  const tctx = terrCanvas.getContext('2d', { willReadFrequently: true });
  let terrImg = null;

  /* ---------------- 配色 ---------------- */

  const BG = [239, 236, 228];                 // 棋盘底（暖白）
  const FACTION_COLOR = { A: '#0A1F44', B: '#FF5A5F', C: '#00A896', D: '#FFC300' };
  const FACTION_RGB = {
    A: [10, 31, 68],
    B: [255, 90, 95],
    C: [0, 168, 150],
    D: [255, 195, 0],
  };
  // 领土：势力本色按比例压在棋盘底色上，同一势力一种色，边界不做任何变色
  const TERR_MIX = 0.72;
  const TERR = { 0: BG };
  for (const ai of ['A', 'B', 'C', 'D']) {
    const c = FACTION_RGB[ai];
    TERR[{ A: 1, B: 2, C: 3, D: 4 }[ai]] = c.map((v, i) => Math.round(v * TERR_MIX + BG[i] * (1 - TERR_MIX)));
  }
  // 编码 5 = 障碍：深灰实心，不参与任何势力配色
  TERR[5] = [62, 64, 70];

  const RES_COLOR = { mine: '#F59E0B', spring: '#06B6D4', fortress: '#8B5CF6', gold: '#FFC300' };
  const FACTION_SHAPE = { A: 'tri', B: 'square', C: 'diamond', D: 'hex' };
  const STRAT_CN = {
    aggressive: '侵略者', economist: '经济人', fortress: '要塞家',
    diplomat: '要塞家', turtle: '龟缩者', llm: 'AI 大模型', auto: '自主决策',
  };
  const STRAT_SHORT = { aggressive: '侵略', economist: '经济', fortress: '要塞', turtle: '龟缩', auto: '自主' };
  const CTRL_STORE = 'bc6-controllers';

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hexToRgba = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})`; };
  /** 与白色混合，得到在深色领土上也读得出来的亮色 */
  const lighten = (h, k) => {
    const [r, g, b] = hexToRgb(h);
    const f = v => Math.round(v + (255 - v) * k);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  };

  let state = null;
  let mapW = 50, mapH = 50;
  let scale = 14;
  let tx = 0, ty = 0;
  let dragging = false, dragStart = null;
  let userMoved = false;
  let eventLog = [];
  let lastLoggedTurn = -1;

  let cfgDef = null, cfgLimits = null, cfgLabels = null;
  let params = {};
  const STORE_KEY = 'bc6-params';

  /* ---------------- 领土位图 ---------------- */

  function renderTerritory(str) {
    if (!str) return;
    if (terrCanvas.width !== mapW || terrCanvas.height !== mapH) {
      terrCanvas.width = mapW;
      terrCanvas.height = mapH;
      terrImg = tctx.createImageData(mapW, mapH);
    }
    if (!terrImg) terrImg = tctx.createImageData(mapW, mapH);

    const d = terrImg.data;
    for (let i = 0; i < mapW * mapH; i++) {
      const o = str.charCodeAt(i) - 48;
      const c = TERR[o] || BG;
      const p = i * 4;
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
    }
    tctx.putImageData(terrImg, 0, 0);
  }

  /* ---------------- 视口 ---------------- */

  function layout() {
    const w = Math.max(1, wrap.clientWidth);
    const h = Math.max(1, wrap.clientHeight);

    if (!userMoved) {
      // 正方形棋盘 + 整数格宽：格子、图标、领土位图严格对齐，不会错半格
      scale = Math.max(4, Math.floor((Math.min(w, h) * 0.97) / Math.max(mapW, mapH)));
      tx = 0; ty = 0;
    }

    const cw = Math.round(mapW * scale);
    const ch = Math.round(mapH * scale);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
    draw();
  }

  const fitView = () => { userMoved = false; layout(); };

  /** 格心坐标：格 (1,1) 的中心在 (0.5*scale, 0.5*scale) */
  const cxOf = x => (x - 0.5) * scale;
  const cyOf = y => (y - 0.5) * scale;

  /* ---------------- 图元 ---------------- */

  function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }

  function shapePath(g, kind, cx, cy, r) {
    g.beginPath();
    if (kind === 'tri') {
      g.moveTo(cx, cy - r * 1.05);
      g.lineTo(cx + r * 0.95, cy + r * 0.7);
      g.lineTo(cx - r * 0.95, cy + r * 0.7);
      g.closePath();
    } else if (kind === 'square') {
      const s = r * 0.84;
      roundRect(g, cx - s, cy - s, s * 2, s * 2, s * 0.3);
    } else if (kind === 'diamond') {
      g.moveTo(cx, cy - r * 1.05);
      g.lineTo(cx + r * 1.0, cy);
      g.lineTo(cx, cy + r * 1.05);
      g.lineTo(cx - r * 1.0, cy);
      g.closePath();
    } else {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    }
  }

  /* ---------------- 图标（严格限制在单格内） ---------------- */

  function drawMine(g, cx, cy, cell, alive) {
    const s = cell * 0.29;
    g.globalAlpha = alive ? 1 : 0.35;

    // 宝石车身：六边形，暖橙
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i);
      const px = cx + Math.cos(a) * s * 1.12;
      const py = cy + Math.sin(a) * s * 1.12;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = RES_COLOR.mine;
    g.fill();
    g.lineWidth = Math.max(1, cell * 0.055);
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.stroke();

    // 内部刻面
    if (cell >= 8) {
      g.beginPath();
      g.moveTo(cx, cy - s * 0.62);
      g.lineTo(cx + s * 0.52, cy + s * 0.3);
      g.lineTo(cx - s * 0.52, cy + s * 0.3);
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** 中央黄金矿：金色八芒星 + 持有者色环，无主时是暗金环 */
  function drawGoldMine(g, cx, cy, cell, owner) {
    const s = cell * 0.34;
    g.save();
    g.beginPath();
    g.arc(cx, cy, s * 1.2, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fill();
    g.lineWidth = Math.max(1.2, cell * 0.075);
    g.strokeStyle = owner ? (FACTION_COLOR[owner] || '#8A6A18') : '#8A6A18';
    g.stroke();

    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 4;
      const rad = i % 2 ? s * 0.42 : s;
      const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = RES_COLOR.gold;
    g.fill();
    g.lineWidth = Math.max(1, cell * 0.045);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.stroke();
    g.restore();
  }

  function drawSpring(g, cx, cy, cell) {
    const r = cell * 0.36;

    // 水塘
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = RES_COLOR.spring;
    g.fill();
    g.lineWidth = Math.max(1, cell * 0.055);
    g.strokeStyle = 'rgba(255,255,255,0.94)';
    g.stroke();

    // 内圈水波
    if (cell >= 8) {
      g.beginPath();
      g.arc(cx, cy, r * 0.62, Math.PI * 0.15, Math.PI * 0.85);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = Math.max(0.8, cell * 0.04);
      g.stroke();
    }

    // 水滴
    const d = r * 0.36;
    g.beginPath();
    g.moveTo(cx, cy - d * 1.5);
    g.quadraticCurveTo(cx + d, cy - d * 0.1, cx, cy + d * 0.7);
    g.quadraticCurveTo(cx - d, cy - d * 0.1, cx, cy - d * 1.5);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
  }

  function drawFortress(g, cx, cy, cell, claimedBy) {
    const w = cell * 0.62, h = cell * 0.6;
    const x = cx - w / 2, y = cy - h / 2 + cell * 0.02;

    // 归属环：同色，不用别的颜色
    if (claimedBy && cell >= 8) {
      g.beginPath();
      g.arc(cx, cy, cell * 0.44, 0, Math.PI * 2);
      g.strokeStyle = hexToRgba(FACTION_COLOR[claimedBy], 0.9);
      g.lineWidth = Math.max(1.4, cell * 0.07);
      g.stroke();
    }

    // 城墙主体
    g.beginPath();
    g.moveTo(x, y + h * 0.28);
    g.lineTo(x, y);
    g.lineTo(x + w * 0.28, y);
    g.lineTo(x + w * 0.28, y + h * 0.16);
    g.lineTo(x + w * 0.42, y + h * 0.16);
    g.lineTo(x + w * 0.42, y);
    g.lineTo(x + w * 0.58, y);
    g.lineTo(x + w * 0.58, y + h * 0.16);
    g.lineTo(x + w * 0.72, y + h * 0.16);
    g.lineTo(x + w * 0.72, y);
    g.lineTo(x + w, y);
    g.lineTo(x + w, y + h * 0.28);
    g.lineTo(x + w, y + h);
    g.lineTo(x, y + h);
    g.closePath();
    g.fillStyle = RES_COLOR.fortress;
    g.fill();
    g.lineWidth = Math.max(1, cell * 0.05);
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.stroke();

    // 城门
    if (cell >= 9) {
      const gw = w * 0.26, gh = h * 0.4;
      g.beginPath();
      g.moveTo(cx - gw / 2, y + h);
      g.lineTo(cx - gw / 2, y + h - gh + gw / 2);
      g.quadraticCurveTo(cx, y + h - gh - gw * 0.2, cx + gw / 2, y + h - gh + gw / 2);
      g.lineTo(cx + gw / 2, y + h);
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,0.82)';
      g.fill();
    }
  }

  function drawBase(g, b, cell, occupied, cx0, cy0) {
    const col = b.alive ? FACTION_COLOR[b.owner] : '#a8a6a0';
    const ratio = b.maxHp ? Math.max(0, b.hp / b.maxHp) : 1;
    const half = cell / 2;

    // 白色底板：把基地格从同色领土里干净地抠出来
    g.fillStyle = b.alive ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.35)';
    g.fillRect(cx0 - half + 0.5, cy0 - half + 0.5, cell - 1, cell - 1);

    // 没有驻军时画一个房子，让基地自己也认得出来
    if (!occupied && b.alive) {
      const w = cell * 0.46, h = cell * 0.42;
      const x = cx0 - w / 2, y = cy0 - h / 2 + cell * 0.06;
      g.beginPath();
      g.moveTo(cx0, y - h * 0.22);
      g.lineTo(x + w, y + h * 0.22);
      g.lineTo(x + w * 0.82, y + h * 0.22);
      g.lineTo(x + w * 0.82, y + h);
      g.lineTo(x + w * 0.18, y + h);
      g.lineTo(x + w * 0.18, y + h * 0.22);
      g.lineTo(x, y + h * 0.22);
      g.closePath();
      g.fillStyle = col;
      g.fill();
      g.lineWidth = Math.max(0.9, cell * 0.04);
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.stroke();
    }

    // 四角括号：常驻识别符号，不会被驻军挡住
    const l = half - cell * 0.05;
    const arm = Math.max(cell * 0.26, 3);
    g.strokeStyle = b.alive ? col : '#b9b6b0';
    g.lineWidth = Math.max(2, cell * 0.12);
    g.lineCap = 'square';
    g.beginPath();
    g.moveTo(cx0 - l + arm, cy0 - l); g.lineTo(cx0 - l, cy0 - l); g.lineTo(cx0 - l, cy0 - l + arm);
    g.moveTo(cx0 + l - arm, cy0 - l); g.lineTo(cx0 + l, cy0 - l); g.lineTo(cx0 + l, cy0 - l + arm);
    g.moveTo(cx0 - l + arm, cy0 + l); g.lineTo(cx0 - l, cy0 + l); g.lineTo(cx0 - l, cy0 + l - arm);
    g.moveTo(cx0 + l - arm, cy0 + l); g.lineTo(cx0 + l, cy0 + l); g.lineTo(cx0 + l, cy0 + l - arm);
    g.stroke();
    g.lineCap = 'butt';

    // 耐久条贴格子顶部
    if (b.alive && ratio < 0.999) {
      const bw = cell * 0.74, bh = Math.max(1.8, cell * 0.1);
      const bx = cx0 - bw / 2, by = cy0 - half + cell * 0.045;
      roundRect(g, bx, by, bw, bh, bh / 2);
      g.fillStyle = 'rgba(40,40,36,0.28)';
      g.fill();
      roundRect(g, bx, by, Math.max(bh, bw * ratio), bh, bh / 2);
      g.fillStyle = ratio > 0.5 ? '#3f8f6d' : '#c2544f';
      g.fill();
    }

    if (!b.alive) {
      g.strokeStyle = '#c2544f';
      g.lineWidth = Math.max(2, cell * 0.12);
      const k = cell * 0.2;
      g.beginPath();
      g.moveTo(cx0 - k, cy0 - k); g.lineTo(cx0 + k, cy0 + k);
      g.moveTo(cx0 + k, cy0 - k); g.lineTo(cx0 - k, cy0 + k);
      g.stroke();
    }
  }

  function drawUnit(g, u, cell, cx0, cy0) {
    const kind = FACTION_SHAPE[u.owner] || 'square';
    const col = FACTION_COLOR[u.owner] || '#8d908c';
    const r = cell * 0.37;

    // 投影：深色领土上靠阴影拉开层次，不糊白色光圈（小格子会糊成一团）
    g.save();
    g.shadowColor = 'rgba(20,22,26,0.45)';
    g.shadowBlur = cell * 0.22;
    g.shadowOffsetY = cell * 0.05;
    shapePath(g, kind, cx0, cy0, r);
    g.fillStyle = col;
    g.fill();
    g.restore();

    // 白色描边：任何底色上都读得出来
    shapePath(g, kind, cx0, cy0, r);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = Math.max(0.9, cell * 0.05);
    g.stroke();

    // 泉水加成：右上角一滴水
    if (u.spring > 0 && cell >= 9) {
      const bx = cx0 + cell * 0.27, by = cy0 - cell * 0.27;
      g.beginPath();
      g.arc(bx, by, Math.max(1.6, cell * 0.095), 0, Math.PI * 2);
      g.fillStyle = '#22D3EE';
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = Math.max(0.7, cell * 0.025);
      g.stroke();
    }

    // 血条：贴格子底部，永远在格内
    if (cell >= 9 && u.hp < u.maxHp) {
      const ratio = Math.max(0, u.hp / u.maxHp);
      const bw = cell * 0.62, bh = Math.max(1.4, cell * 0.07);
      const bx = cx0 - bw / 2, by = cy0 + cell / 2 - bh - cell * 0.05;
      roundRect(g, bx, by, bw, bh, bh / 2);
      g.fillStyle = 'rgba(24,26,24,0.35)';
      g.fill();
      roundRect(g, bx, by, Math.max(bh, bw * ratio), bh, bh / 2);
      g.fillStyle = ratio > 0.6 ? '#3f8f6d' : ratio > 0.3 ? '#d09a2e' : '#c2544f';
      g.fill();
    }
  }

  /* ---------------- 主绘制 ---------------- */

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = mapW * scale;
    const H = mapH * scale;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = `rgb(${BG[0]},${BG[1]},${BG[2]})`;
    ctx.fillRect(0, 0, W, H);

    // 领土位图：1 像素 = 1 格，最近邻放大，边界自然就是势力同色
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrCanvas, 0, 0, W, H);
    ctx.imageSmoothingEnabled = true;

    if (!state) return;

    // 网格：弱到只当坐标参考
    if (scale >= 7) {
      ctx.strokeStyle = 'rgba(70,68,62,0.07)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const step = scale >= 18 ? 5 : 10;
      for (let g = 0; g <= mapW; g += step) {
        const p = Math.round(g * scale) + 0.5;
        ctx.moveTo(p, 0); ctx.lineTo(p, H);
      }
      for (let g = 0; g <= mapH; g += step) {
        const p = Math.round(g * scale) + 0.5;
        ctx.moveTo(0, p); ctx.lineTo(W, p);
      }
      ctx.stroke();
    }

    const cell = scale;

    for (const r of state.resources) {
      const cx0 = cxOf(r.x), cy0 = cyOf(r.y);
      if (r.type === 'mine') drawMine(ctx, cx0, cy0, cell, r.stock > 0);
      else if (r.type === 'spring') drawSpring(ctx, cx0, cy0, cell);
      else drawFortress(ctx, cx0, cy0, cell, r.claimedBy);
    }

    // 中央黄金矿独立于 resources：无限产出、可被攻占
    if (state.goldMine) {
      drawGoldMine(ctx, cxOf(state.goldMine.x), cyOf(state.goldMine.y), cell, state.goldMine.owner);
    }

    if (state.bases) {
      for (const ai of ['A', 'B', 'C', 'D']) {
        const b = state.bases[ai];
        if (!b) continue;
        const occupied = state.units.some(u => u.x === b.x && u.y === b.y);
        drawBase(ctx, { ...b, owner: ai }, cell, occupied, cxOf(b.x), cyOf(b.y));
      }
    }

    for (const u of state.units) drawUnit(ctx, u, cell, cxOf(u.x), cyOf(u.y));

    ctx.strokeStyle = 'rgba(110,106,98,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  /* ---------------- 棋盘旁：图标示例 + 每回合变化 ---------------- */

  const AIS = ['A', 'B', 'C', 'D'];
  const OWNER_CODE_UI = { A: 1, B: 2, C: 3, D: 4 };
  const PANEL_W = 236, LEG_H = 300, TR_H = 122;
  const legendCanvas = document.getElementById('legendCanvas');
  const lctx = legendCanvas.getContext('2d');
  const trendCanvas = document.getElementById('trendCanvas');
  const rctx = trendCanvas.getContext('2d');
  const METRICS = ['territory', 'units', 'stock', 'kills'];
  const METRIC_CN = { territory: '领土', units: '士兵', stock: '资源', kills: '击杀' };
  let metric = 'territory';

  function setupPanel(cv, c, h) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(PANEL_W * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = PANEL_W + 'px';
    cv.style.height = h + 'px';
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }

  function panelText(g, t, x, y, size = 10, color = '#6f757d', weight = 400, align = 'left') {
    g.font = `${weight} ${size}px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(t, x, y);
    g.textAlign = 'left';
  }

  /** 用主棋盘同一套图元函数画示例，保证「示例 = 实际」 */
  function drawLegend() {
    const g = setupPanel(legendCanvas, lctx, LEG_H);
    g.clearRect(0, 0, PANEL_W, LEG_H);
    g.fillStyle = '#f7f5f0';
    g.fillRect(0, 0, PANEL_W, LEG_H);
    const cell = 26;

    const section = (t, y) => {
      panelText(g, t, 10, y, 9, '#a9adb3', 600);
      g.strokeStyle = '#e9e5dc';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(10, y + 5.5); g.lineTo(PANEL_W - 10, y + 5.5); g.stroke();
    };

    section('士兵 · 四家形状', 16);
    AIS.forEach((ai, i) => {
      const x = 34 + 54 * i;
      drawUnit(g, { owner: ai, hp: 1, maxHp: 1, spring: 0 }, cell, x, 43);
      panelText(g, ai, x, 69, 9.5, FACTION_COLOR[ai], 700, 'center');
    });

    section('资源与建筑', 91);
    const rows = [
      { y: 110, label: '矿点 · 站上去采集 +3 资源', draw: (gg, x, y) => drawMine(gg, x, y, cell, true) },
      { y: 134, label: '泉水 · 踩过攻击 +3（4 回合）', draw: (gg, x, y) => drawSpring(gg, x, y, cell) },
      { y: 158, label: '要塞 · 每 4 回合自动开垦', draw: (gg, x, y) => drawFortress(gg, x, y, cell, null) },
      { y: 182, label: '黄金矿 · 占领后每回合产出', draw: (gg, x, y) => drawGoldMine(gg, x, y, cell, null) },
      { y: 206, label: '基地 · 白底 + 四角括号', draw: (gg, x, y) => drawBase(gg, { alive: true, hp: 20, maxHp: 20, owner: 'A' }, cell, false, x, y) },
    ];
    for (const r of rows) {
      r.draw(g, 27, r.y);
      panelText(g, r.label, 52, r.y + 3.5, 10);
    }

    section('领土 · 势力同色，边界不变色', 234);
    const swatches = ['A', 'B', 'C', 'D', '中立', '障碍'];
    swatches.forEach((name, i) => {
      const x = 10 + 37 * i;
      const c = name === '中立' ? BG : (name === '障碍' ? TERR[5] : TERR[OWNER_CODE_UI[name]]);
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.fillRect(x, 245, 20, 20);
      g.strokeStyle = 'rgba(90,86,78,0.2)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, 245.5, 19, 19);
      panelText(g, name, x + 10, 279, 9, '#8b9098', 500, 'center');
    });
  }

  /** 四条折线：最近 160 回合的领土 / 士兵 / 资源 / 击杀 */
  function drawTrend() {
    const g = setupPanel(trendCanvas, rctx, TR_H);
    g.clearRect(0, 0, PANEL_W, TR_H);
    g.fillStyle = '#f7f5f0';
    g.fillRect(0, 0, PANEL_W, TR_H);

    const hist = (state && Array.isArray(state.history)) ? state.history : [];
    const pts = hist.filter(h => h && h[metric]);
    panelText(g, `${METRIC_CN[metric]} · 逐回合`, 8, 12, 9, '#a9adb3', 600);
    if (pts.length < 2) {
      panelText(g, '等待回合数据…', PANEL_W / 2, TR_H / 2 + 4, 10, '#b9bcc0', 400, 'center');
      return;
    }

    let max = 1;
    for (const p of pts) for (const ai of AIS) max = Math.max(max, Number(p[metric][ai]) || 0);
    max = Math.ceil(max * 1.12);
    const L = 8, R = PANEL_W - 8, T = 20, B = TR_H - 16;
    const px = i => L + (R - L) * (pts.length === 1 ? 0 : i / (pts.length - 1));
    const py = v => B - (B - T) * Math.min(1, (Number(v) || 0) / max);

    g.strokeStyle = '#e9e5dc';
    g.lineWidth = 1;
    for (let k = 0; k <= 2; k++) {
      const y = T + (B - T) * k / 2 + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
    }
    panelText(g, String(max), R, T - 6, 8.5, '#b9bcc0', 400, 'right');
    panelText(g, `T${pts[0].turn}`, L, B + 10, 8.5, '#b9bcc0');
    panelText(g, `T${pts[pts.length - 1].turn}`, R, B + 10, 8.5, '#b9bcc0', 400, 'right');

    for (const ai of AIS) {
      g.beginPath();
      pts.forEach((p, i) => {
        const x = px(i), y = py(p[metric][ai]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = FACTION_COLOR[ai];
      g.lineWidth = 1.7;
      g.lineJoin = 'round';
      g.stroke();

      const last = pts[pts.length - 1];
      g.beginPath();
      g.arc(R, py(last[metric][ai]), 2.4, 0, Math.PI * 2);
      g.fillStyle = FACTION_COLOR[ai];
      g.fill();
    }
  }

  /** 与上一回合对比的 Δ，四家 × 四个指标 */
  function lastDelta(key, ai) {
    const h = state && state.history;
    if (!h || h.length < 2) return null;
    const cur = h[h.length - 1], prev = h[h.length - 2];
    return (Number(cur?.[key]?.[ai]) || 0) - (Number(prev?.[key]?.[ai]) || 0);
  }

  function deltaTag(d, showZero = false) {
    if (d === null || (!showZero && d === 0)) return '';
    const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    return `<i class="d ${cls}">${d > 0 ? '+' : ''}${d === 0 ? '·' : d}</i>`;
  }

  function updateDock() {
    const h = (state && Array.isArray(state.history)) ? state.history : [];
    const cur = h[h.length - 1];
    const prev = h.length > 1 ? h[h.length - 2] : null;
    const turn = cur ? cur.turn : 0;
    document.getElementById('trendTurn').textContent = `T${turn}`;
    document.getElementById('deltaTurn').textContent = `T${turn}`;

    document.getElementById('deltaBody').innerHTML = AIS.map(ai => {
      const cells = METRICS.map(key => {
        const v = Number(cur?.[key]?.[ai]) || 0;
        const d = prev ? v - (Number(prev[key]?.[ai]) || 0) : null;
        const cls = d === null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
        const txt = d === null ? '—' : `${d > 0 ? '+' : ''}${d === 0 ? '·' : d}`;
        return `<td><span class="v">${v}</span><i class="d ${cls}">${txt}</i></td>`;
      }).join('');
      return       `<tr><td style="color:${FACTION_COLOR[ai]}">${ai}</td>${cells}</tr>`;
    }).join('');

    renderLeaderboard();
    renderRecords();
    renderMemory(state && state.memory);
    drawTrend();
  }

  document.querySelectorAll('#metricTabs button').forEach(btn => {
    btn.onclick = () => {
      metric = btn.dataset.metric;
      document.querySelectorAll('#metricTabs button').forEach(b => b.classList.toggle('on', b === btn));
      drawTrend();
    };
  });

  /* ---------------- 交互 ---------------- */

  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    userMoved = true;
    dragStart = { x: e.clientX - tx, y: e.clientY - ty };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    tx = e.clientX - dragStart.x;
    ty = e.clientY - dragStart.y;
    canvas.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - (rect.left + mapW * scale / 2);
    const my = e.clientY - (rect.top + mapH * scale / 2);

    const old = scale;
    scale = Math.min(48, Math.max(4, Math.round(scale * (e.deltaY < 0 ? 1.15 : 0.87))));
    const k = scale / old;
    tx -= mx * (k - 1);
    ty -= my * (k - 1);
    userMoved = true;
    layout();
  }, { passive: false });

  /* ---------------- Socket ---------------- */

  const socket = io();
  socket.on('connect', () => {
    const b = document.getElementById('statusBadge');
    if (!state) { b.classList.remove('live'); b.textContent = '已连接'; }
  });
  socket.on('state', onState);

  function onState(s) {
    if (!s) return;
    if (s.mapW && s.mapW !== mapW) { mapW = s.mapW; mapH = s.mapH; userMoved = false; }
    if (s.territory) renderTerritory(s.territory);

    if (Array.isArray(s.history) && s.history.length) {
      const log = [];
      for (const h of s.history) for (const e of (h.events || [])) if (e) log.push({ t: h.turn, e });
      if (log.length) eventLog = log;
    } else if (s.turn !== lastLoggedTurn) {
      lastLoggedTurn = s.turn;
      const evs = (s.events || []).filter(Boolean);
      if (s.turn === 0) eventLog = evs.map(e => ({ t: 0, e }));
      else eventLog.push(...evs.map(e => ({ t: s.turn, e })));
    }
    if (eventLog.length > 240) eventLog = eventLog.slice(-240);

    state = s;
    const gmBox = document.getElementById('goldMineInfo');
    if (gmBox && s.goldMine) {
      const gm = s.goldMine;
      gmBox.innerHTML = `中央黄金矿 <b>(${gm.x},${gm.y})</b>：` +
        (gm.owner
          ? `<b style="color:${FACTION_COLOR[gm.owner] || '#8A6A18'}">${gm.owner} 占领中</b>，每回合 +${gm.yield}`
          : '无主，谁先踩上去归谁') +
        `<br />累计产出 ${gm.produced} 资源 · 障碍 ${s.wallCount ?? 0} 格`;
    }
    syncLlmPublic(s.llm);
    updateSidebar();
    updateDock();
    renderControllerStates();
    if (!userMoved) layout(); else draw();
  }

  function updateSidebar() {
    if (!state) return;
    const total = state.maxTurns || 120;
    document.getElementById('turnLabel').innerHTML = `${state.turn} <small>/ ${total} 回合</small>`;

    const cells = state.cells || 1;
    const order = state.ranking || Object.keys(state.territoryCount);
    const maxCells = Math.max(1, ...order.map(a => state.territoryCount[a] || 0));
    const cfg = state.cfg || {};

    document.getElementById('scores').innerHTML = order.map(ai => {
      const tc = state.territoryCount[ai] || 0;
      const pct = tc / cells * 100;
      const alive = state.alive ? state.alive[ai] : 0;
      const stock = state.stock ? state.stock[ai] : 0;
      const base = state.bases ? state.bases[ai] : null;
      const hasBase = state.hasBase ? state.hasBase[ai] : alive > 0;
      const strat = state.assignment ? state.assignment[ai] : '';
      const cls = ['faction'];
      if (state.winner === ai) cls.push('win');
      if (!hasBase) cls.push('dead');
      const w = Math.max(2, tc / maxCells * 100);

      const baseTxt = !base ? '' : hasBase
        ? `<span title="基地耐久">基地 <b>${base.hp}</b>/${base.maxHp}</span>`
        : '<span style="color:#c2544f">已亡国</span>';
      const canBuild = hasBase && stock >= (cfg.unitCost || 12);

      return `<div class="${cls.join(' ')}">
        <div class="f-top">
          <span class="dot ${ai}"></span>
          <span class="f-name">${ai}</span>
          <span class="f-tag">${STRAT_CN[strat] || ''}</span>
          <span class="f-num">${pct.toFixed(1)}%</span>
        </div>
        <div class="bar"><i style="width:${w}%;background:${FACTION_COLOR[ai]}"></i></div>
        <div class="f-sub">
          <span>${tc.toLocaleString()} 格${deltaTag(lastDelta('territory', ai))}</span>
          <span>兵 <b>${alive}</b>/${cfg.maxUnits || 14}${deltaTag(lastDelta('units', ai))}</span>
          <span style="${canBuild ? 'color:#2f7d5f' : ''}">资源 <b>${stock}</b>${deltaTag(lastDelta('stock', ai))}</span>
          ${baseTxt}
        </div>
        ${strat === 'llm' ? `<div class="f-sub" style="margin-top:2px;color:${(state.llm?.perAI?.[ai]?.state === 'ok') ? '#2f7d5f' : '#c08a2e'}">模型 · ${LLM_STATE_CN[state.llm?.perAI?.[ai]?.state] || '待命'}${state.llm?.perAI?.[ai]?.ms != null ? ` · ${state.llm.perAI[ai].ms}ms` : ''}</div>` : ''}
      </div>`;
    }).join('');

    const eventsEl = document.getElementById('events');
    eventsEl.innerHTML = eventLog.length
      ? eventLog.slice(-20).map(x => `<div><span class="t">T${String(x.t).padStart(3, '0')}</span>${x.e}</div>`).join('')
      : '<div>—</div>';
    eventsEl.scrollTop = eventsEl.scrollHeight;

    const badge = document.getElementById('statusBadge');
    const over = state.over || !!state.winner;
    if (over) {
      const label = state.winType === 'conquest' ? '征服胜利'
        : state.winType === 'territory' ? '领土胜利' : '结束';
      badge.textContent = `${state.winner} ${label}`;
      badge.classList.remove('live');
      badge.classList.add('over');
    } else {
      badge.textContent = state.turn > 0 ? `回合 ${state.turn} / ${total}` : '待开始';
      badge.classList.toggle('live', state.turn > 0);
      badge.classList.remove('over');
    }

    document.getElementById('btnStep').disabled = over;
    document.getElementById('btnAuto').disabled = over;
  }

  /* ---------------- 参数面板 ---------------- */

  function buildParams(config) {
    cfgDef = config.defaults;
    cfgLimits = config.limits;
    cfgLabels = config.labels;

    // 面板初值优先用「服务端当前生效的参数」，其次才是上次本地保存 / 出厂默认
    let saved = { ...(config.cfg || {}) };
    try {
      const local = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (local && Object.keys(local).length) saved = local;
    } catch { /* 用服务端值 */ }

    const box = document.getElementById('params');
    box.innerHTML = '';

    for (const key of Object.keys(cfgLabels)) {
      const [min, max, step] = cfgLimits[key];
      const raw = Number(saved[key]);
      const val = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : cfgDef[key];
      params[key] = val;

      const field = document.createElement('div');
      field.className = 'p-field';
      field.innerHTML = `
        <label title="${cfgLabels[key]}">${cfgLabels[key]}</label>
        <input type="number" id="p-${key}" min="${min}" max="${max}" step="${step}" value="${val}" />
        <span class="p-range">${min} – ${max}</span>`;
      box.appendChild(field);

      const input = field.querySelector('input');
      input.addEventListener('change', () => {
        let v = Number(input.value);
        if (!Number.isFinite(v)) v = cfgDef[key];
        const clamped = Math.min(max, Math.max(min, v));
        input.classList.toggle('bad', clamped !== v);
        input.value = clamped;
        params[key] = clamped;
        persist();
      });
      input.addEventListener('blur', () => input.classList.remove('bad'));
    }

  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* 忽略 */ }
  }

  function resetParams() {
    params = { ...cfgDef };
    for (const key of Object.keys(cfgDef)) {
      const el = document.getElementById(`p-${key}`);
      if (el) { el.value = cfgDef[key]; el.classList.remove('bad'); }
    }
    persist();
  }

  /* ---------------- 大模型接入 + 多模型列表 + 势力操控 ---------------- */

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const FALLBACK_STYLES = [
    { key: 'auto', label: '默认 / 自主', botLabel: '默认打法', llmLabel: '自主决策' },
    { key: 'aggressive', label: '侵略者' },
    { key: 'economist', label: '经济人' },
    { key: 'fortress', label: '要塞家' },
    { key: 'turtle', label: '龟缩者' },
  ];
  const LLM_STATE_CN = {
    idle: '待命', bot: '脚本', ok: '模型 OK', parse: '输出异常',
    error: '已降级', nokey: '缺 Key',
  };

  let llmInfo = null;
  let presets = [];
  let styleOptions = FALLBACK_STYLES;
  let controllersUI = null;
  let llmBusy = false;
  let profiles = [];
  let profileSig = '';
  let editingProfileId = null;
  let confirmDeleteId = null;

  function setLlmStatus(text, kind = '') {
    const el = $('llmStatus');
    el.className = `llm-status ${kind}`;
    el.textContent = text;
  }

  /** 服务端广播过来的 llmPublic：只同步只读状态，不覆盖用户正在填的表单 */
  function syncLlmPublic(info) {
    if (!info) return;
    llmInfo = info;
    if (!Array.isArray(info.profiles)) return;
    const sig = JSON.stringify(info.profiles.map(p => [
      p.id, p.name, p.model, p.keyMask, p.isDefault, p.hasKey, p.testedAt,
    ])) + '|' + (info.defaultProfileId || '');
    if (sig === profileSig) return;
    profileSig = sig;
    profiles = info.profiles;
    renderProfiles();
    refreshControllerOptions();
  }

  /** 初次载入 / 清空表单时用默认配置回填表单 */
  function renderLlmInfo(info) {
    if (!info) return;
    syncLlmPublic(info);
    if (Array.isArray(info.presets) && info.presets.length) presets = info.presets;
    const pv = $('llmProvider');
    if (!pv.options.length) {
      pv.innerHTML = presets.map(p => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('');
    }
    pv.value = info.provider || 'openai';
    $('llmBase').value = info.baseURL || '';
    $('llmModel').value = info.model || '';
    $('llmTemp').value = info.temperature ?? 0.7;
    $('llmTimeout').value = Math.round((info.timeoutMs ?? 25000) / 1000);

    const n = profiles.length;
    if (info.lastError) setLlmStatus(`上次错误：${info.lastError}`, 'bad');
    else if (info.hasKey) {
      const src = info.keySource === 'env' ? '环境变量' : '本机';
      setLlmStatus(`默认模型已就绪 · ${info.providerLabel} · ${info.model} · 密钥 ${info.keyMask}（${src}） · 已保存 ${n} 份模型`, 'on');
    } else {
      setLlmStatus(`未配置默认模型 · 已保存 ${n} 份模型 · 填 API Key 后点「保存为模型」`, '');
    }
  }

  /* ---------------- 已保存的模型 ---------------- */

  function renderProfiles() {
    const box = $('profileList');
    if (!box) return;
    $('profileCount').textContent = `${profiles.length} 份`;
    if (!profiles.length) {
      box.innerHTML = '<div class="prof-empty">还没有保存的模型。填好名称 / 服务商 / API Key 后点「保存为模型」；可保存多份，随后在下方「势力操控」里逐个选给 A / B / C / D。</div>';
      return;
    }
    box.innerHTML = profiles.map(p => `
      <div class="prof-row ${p.isDefault ? 'default' : ''}">
        <div class="prof-main">
          <div class="prof-name">${esc(p.name)}${p.isDefault ? '<span class="tag">默认</span>' : ''}${p.hasKey ? '' : '<span class="nokey">缺 Key</span>'}</div>
          <div class="prof-meta">${esc(p.providerLabel)} · ${esc(p.model || '自定义模型')} · ${esc(p.keyMask || '—')}${p.testedAt ? ' · 已验证' : ''}</div>
          <div class="prof-acts">
            <button data-act="load" data-id="${esc(p.id)}"${editingProfileId === p.id ? ' class="on"' : ''}>${editingProfileId === p.id ? '编辑中' : '载入编辑'}</button>
            <button data-act="default" data-id="${esc(p.id)}"${p.isDefault ? ' disabled' : ''}>设为默认</button>
            <button data-act="test" data-id="${esc(p.id)}">测试</button>
            <button data-act="del" data-id="${esc(p.id)}" class="danger">${confirmDeleteId === p.id ? '确认删除?' : '删除'}</button>
          </div>
        </div>
      </div>`).join('');
    box.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => onProfileAction(btn.dataset.act, btn.dataset.id);
    });
  }

  function resetForm(keepProvider = false) {
    editingProfileId = null;
    $('llmName').value = '';
    $('llmKey').value = '';
    $('llmKey').placeholder = '只填这一项即可开跑';
    $('llmMakeDefault').checked = true;
    if (!keepProvider && llmInfo) {
      $('llmProvider').value = llmInfo.provider || 'openai';
      $('llmBase').value = llmInfo.baseURL || '';
      $('llmModel').value = llmInfo.model || '';
      $('llmTemp').value = llmInfo.temperature ?? 0.7;
      $('llmTimeout').value = Math.round((llmInfo.timeoutMs ?? 25000) / 1000);
    }
  }

  function llmPayload(withKey, allowPersist = true) {
    const p = {
      provider: $('llmProvider').value,
      baseURL: $('llmBase').value.trim(),
      model: $('llmModel').value.trim(),
      temperature: Number($('llmTemp').value),
      timeoutMs: Math.round(Number($('llmTimeout').value) * 1000),
      persist: allowPersist && $('llmPersist').checked,
    };
    if (withKey) {
      const k = $('llmKey').value.trim();
      if (k) p.apiKey = k;
    }
    return p;
  }

  function profilePayload() {
    const p = llmPayload(true, false);
    p.name = $('llmName').value.trim();
    p.makeDefault = $('llmMakeDefault').checked;
    p.persist = $('llmPersist').checked;
    if (editingProfileId) p.id = editingProfileId;
    return p;
  }

  async function saveProfile() {
    if (llmBusy) return;
    const body = profilePayload();
    if (!editingProfileId && !body.apiKey) {
      setLlmStatus('请先填 API Key；要改已有模型，请在下方列表点「载入编辑」', 'bad');
      return;
    }
    llmBusy = true;
    const r = await api('/api/llm/profiles', body);
    llmBusy = false;
    if (!r.ok) { setLlmStatus(`保存失败：${r.error || '未知错误'}`, 'bad'); return; }
    syncLlmPublic(r);
    resetForm(true);
    renderProfiles();
    refreshControllerOptions();
    setLlmStatus(`已保存「${r.profile.name}」· ${r.profile.providerLabel} · ${r.profile.model || '自定义端点'} · 密钥 ${r.profile.keyMask || '未配置'}${r.madeDefault ? ' · 已设为默认' : ''}${r.persisted ? ' · 已写入 .env' : ''} · 现在可在势力操控里选它`, 'on');
    renderControllerStates();
  }

  async function testLlm() {
    if (llmBusy) return;
    llmBusy = true;
    setLlmStatus('正在测试连接…', '');
    const typed = $('llmKey').value.trim();
    const body = editingProfileId
      ? { id: editingProfileId, ...(typed ? { apiKey: typed } : {}) }
      : { ...llmPayload(true, false), noAutoSave: true };
    const r = await api(editingProfileId ? '/api/llm/profiles/test' : '/api/llm/test', body);
    llmBusy = false;
    if (!r.ok) { setLlmStatus(`连接失败：${r.error || '未知错误'}`, 'bad'); return; }
    syncLlmPublic(r);
    if (typed) $('llmKey').value = '';
    setLlmStatus(`连接正常 · ${r.ms}ms · 模型回复「${r.preview}」${editingProfileId ? ' · 点「保存为模型」提交修改' : ''}`, 'on');
  }

  function clearLlm() {
    resetForm(false);
    confirmDeleteId = null;
    renderProfiles();
    setLlmStatus('表单已清空；已保存的模型不受影响', '');
  }

  async function onProfileAction(act, id) {
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    if (act === 'load') {
      editingProfileId = editingProfileId === id ? null : id;
      if (editingProfileId) {
        $('llmName').value = p.name;
        $('llmProvider').value = p.provider;
        $('llmBase').value = p.baseURL || '';
        $('llmModel').value = p.model || '';
        $('llmTemp').value = p.temperature ?? 0.7;
        $('llmTimeout').value = Math.round((p.timeoutMs ?? 25000) / 1000);
        $('llmKey').value = '';
        $('llmKey').placeholder = '留空 = 保留原密钥';
        // 编辑非默认模型时别把它意外提升为默认
        $('llmMakeDefault').checked = !!p.isDefault;
        setLlmStatus(`正在编辑「${p.name}」· 改完点「保存为模型」覆盖这份配置`, '');
      } else {
        resetForm(false);
        setLlmStatus('已退出编辑', '');
      }
      renderProfiles();
      return;
    }
    if (act === 'del') {
      if (confirmDeleteId !== id) {
        confirmDeleteId = id;
        renderProfiles();
        setTimeout(() => { if (confirmDeleteId === id) { confirmDeleteId = null; renderProfiles(); } }, 4000);
        return;
      }
      confirmDeleteId = null;
    }
    if (llmBusy) return;
    llmBusy = true;
    const url = {
      default: '/api/llm/profiles/default', test: '/api/llm/profiles/test', del: '/api/llm/profiles/delete',
    }[act];
    setLlmStatus(act === 'test' ? `正在测试「${p.name}」…` : '处理中…', '');
    const r = await api(url, { id });
    llmBusy = false;
    if (!r.ok) { setLlmStatus(`操作失败：${r.error || '未知错误'}`, 'bad'); return; }
    syncLlmPublic(r);
    if (act === 'del' && editingProfileId === id) resetForm(false);
    if (act === 'del') setLlmStatus(`已删除「${r.removed || p.name}」；引用它的势力已退回默认模型`, '');
    else if (act === 'default') setLlmStatus(`「${p.name}」已设为默认模型`, 'on');
    else setLlmStatus(`「${p.name}」连接正常 · ${r.ms}ms · 回复「${r.preview}」`, 'on');
    renderProfiles();
    refreshControllerOptions();
    renderControllerStates();
  }

  /* ---------------- 势力操控下拉 ---------------- */

  function styleOptionsHtml(mode, current) {
    return styleOptions.map(o => {
      const label = o.key === 'auto'
        ? (mode === 'llm' ? (o.llmLabel || '自主决策') : (o.botLabel || '默认打法'))
        : o.label;
      return `<option value="${o.key}"${o.key === current ? ' selected' : ''}>${label}</option>`;
    }).join('');
  }

  /** 下拉里既有「自动策略 / 默认大模型」，也有每一份已保存的模型 */
  function modeOptionsHtml() {
    let html = '<optgroup label="操控方式"><option value="bot">自动策略</option><option value="llm">AI 大模型（默认）</option></optgroup>';
    if (profiles.length) {
      html += '<optgroup label="已保存的模型">'
        + profiles.map(p => `<option value="llm:${esc(p.id)}" title="${esc(p.name)} · ${esc(p.model || '')}">${esc(p.name)}</option>`).join('')
        + '</optgroup>';
    }
    return html;
  }

  const modeValueFor = c => c.mode === 'llm' ? (c.profileId ? `llm:${c.profileId}` : 'llm') : 'bot';

  function parseModeValue(v) {
    if (v === 'bot') return { mode: 'bot' };
    if (typeof v === 'string' && v.startsWith('llm:')) return { mode: 'llm', profileId: v.slice(4) };
    return { mode: 'llm' };
  }

  /** 模型列表变化时重建选项，尽量保住当前选择；引用了已删模型的自动退回默认大模型 */
  function refreshControllerOptions() {
    if (!controllersUI) return;
    const html = modeOptionsHtml();
    let changed = false;
    for (const ai of AIS) {
      const sel = document.querySelector(`.c-mode[data-ai="${ai}"]`);
      if (!sel) continue;
      const cur = modeValueFor(controllersUI[ai]);
      sel.innerHTML = html;
      const exists = Array.from(sel.options).some(o => o.value === cur);
      const wanted = exists ? cur : 'llm';
      sel.value = wanted;
      sel.title = sel.options[sel.selectedIndex]?.textContent || '';
      if (wanted !== cur) {
        controllersUI[ai] = { ...parseModeValue(wanted), strategy: controllersUI[ai].strategy || 'auto' };
        changed = true;
      }
    }
    if (changed) {
      try { localStorage.setItem(CTRL_STORE, JSON.stringify(controllersUI)); } catch { /* 忽略 */ }
      api('/api/controllers', { controllers: controllersUI });
    }
  }

  function initControllers(serverCtrl) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CTRL_STORE) || 'null'); } catch { /* 忽略 */ }
    const valid = saved && AIS.every(a => saved[a] && ['bot', 'llm'].includes(saved[a].mode));
    controllersUI = valid ? saved : (serverCtrl || {
      A: { mode: 'bot', strategy: 'aggressive' }, B: { mode: 'bot', strategy: 'economist' },
      C: { mode: 'bot', strategy: 'fortress' }, D: { mode: 'bot', strategy: 'turtle' },
    });

    $('controllerRows').innerHTML = AIS.map(ai => `
      <div class="ctrl-row">
        <span class="dot ${ai}"></span><b>${ai}</b>
        <select class="c-mode" data-ai="${ai}"></select>
        <select class="c-style" data-ai="${ai}"></select>
        <span class="c-state" id="cstate-${ai}">—</span>
      </div>`).join('');

    $('controllerRows').querySelectorAll('.c-mode').forEach(sel => {
      sel.onchange = () => {
        const ai = sel.dataset.ai;
        const mode = parseModeValue(sel.value).mode;
        const st = document.querySelector(`.c-style[data-ai="${ai}"]`);
        st.innerHTML = styleOptionsHtml(mode, st.value);
        sel.title = sel.options[sel.selectedIndex]?.textContent || '';
        const prof = sel.value.startsWith('llm:') ? profiles.find(p => p.id === sel.value.slice(4)) : null;
        const noKey = sel.value === 'llm' ? !(llmInfo && llmInfo.hasKey) : (prof ? !prof.hasKey : false);
        if (mode === 'llm' && noKey) {
          setLlmStatus(`${ai} 选了大模型，但这份配置还没填 API Key —— 会先由脚本代打`, 'bad');
        }
        onControllerChange();
      };
    });
    $('controllerRows').querySelectorAll('.c-style').forEach(sel => { sel.onchange = onControllerChange; });

    for (const ai of AIS) {
      const c = controllersUI[ai];
      document.querySelector(`.c-style[data-ai="${ai}"]`).innerHTML = styleOptionsHtml(c.mode, c.strategy || 'auto');
    }
    refreshControllerOptions();
    // 本地选择优先，同步给服务端
    api('/api/controllers', { controllers: controllersUI });
    renderControllerStates();
  }

  async function onControllerChange() {
    for (const ai of AIS) {
      controllersUI[ai] = {
        ...parseModeValue(document.querySelector(`.c-mode[data-ai="${ai}"]`).value),
        strategy: document.querySelector(`.c-style[data-ai="${ai}"]`).value,
      };
    }
    try { localStorage.setItem(CTRL_STORE, JSON.stringify(controllersUI)); } catch { /* 忽略 */ }
    await api('/api/controllers', { controllers: controllersUI });
    renderControllerStates();
  }

  function renderControllerStates() {
    if (!state || !controllersUI) return;
    for (const ai of AIS) {
      const el = $(`cstate-${ai}`);
      if (!el) continue;
      const ctl = state.controllers?.[ai] || controllersUI[ai];
      const st = state.llm?.perAI?.[ai];
      if (ctl.mode !== 'llm') {
        el.className = 'c-state'; el.textContent = '脚本'; el.title = '';
        continue;
      }
      const prof = ctl.profileId ? profiles.find(p => p.id === ctl.profileId) : null;
      const label = prof ? prof.name : (llmInfo?.model || '默认模型');
      if (ctl.profileId && !prof) {
        el.className = 'c-state warn'; el.textContent = '模型已删'; el.title = '该模型已删除，请重新选择';
      } else if ((prof && !prof.hasKey) || (!ctl.profileId && llmInfo && !llmInfo.hasKey)) {
        el.className = 'c-state warn'; el.textContent = '缺 Key'; el.title = label;
      } else {
        const s = st?.state || 'idle';
        el.className = `c-state ${s === 'ok' ? 'ok' : (s === 'error' || s === 'parse' || s === 'nokey') ? 'bad' : ''}`;
        el.textContent = LLM_STATE_CN[s] || '待命';
        el.title = `${label}${st?.error ? ' · ' + st.error : ''}${st?.ms != null ? ` · 上回合 ${st.ms}ms` : ''}`;
      }
    }
  }

  /* ---------------- 排行榜 ---------------- */

  function previousRanks() {
    const h = state && state.history;
    if (!h || h.length < 2 || !h[h.length - 2]?.territory) return {};
    const t = h[h.length - 2].territory;
    return Object.fromEntries(AIS.slice().sort((a, b) => (t[b] || 0) - (t[a] || 0)).map((ai, i) => [ai, i + 1]));
  }

  function renderLeaderboard() {
    const lb = state && state.leaderboard;
    if (!lb || !lb.length) return;
    $('rankTurn').textContent = `T${state.turn}`;
    const max = Math.max(1, ...lb.map(r => r.territory));
    const prev = previousRanks();
    $('leaderboard').innerHTML = lb.map(r => {
      const d = prev[r.ai] ? prev[r.ai] - r.rank : 0;
      const chg = d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '—';
      const cCls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      const badge = r.mode === 'llm'
        ? `<span class="lb-badge llm">大模型${r.strategy !== 'auto' ? ' · ' + (STRAT_SHORT[r.strategy] || '') : ''}</span>`
        : `<span class="lb-badge">${STRAT_CN[r.strategy] || '默认打法'}</span>`;
      const llm = r.llm?.state;
      const llmTag = r.mode === 'llm' && llm && llm !== 'ok' && llm !== 'idle'
        ? `<span style="color:#c2544f">${LLM_STATE_CN[llm] || llm}</span>` : '';
      const modelTag = r.mode === 'llm' && r.model
        ? `<span style="color:#3a6091" title="${esc(r.model)}">${esc(r.model)}</span>` : '';
      return `<div class="lb-row ${r.rank === 1 ? 'top' : ''} ${r.alive ? '' : 'dead'}">
        <span class="lb-rank">${r.rank}</span>
        <span class="dot ${r.ai}"></span>
        <div class="lb-main">
          <div class="lb-top"><b style="color:${FACTION_COLOR[r.ai]}">${r.ai}</b>${badge}<span class="lb-chg ${cCls}">${chg}</span><span class="lb-pct">${r.pct.toFixed(1)}%</span></div>
          <div class="lb-bar"><i style="width:${Math.max(2, r.territory / max * 100)}%;background:${FACTION_COLOR[r.ai]}"></i></div>
          <div class="lb-sub"><span>${r.territory.toLocaleString()} 格</span><span>兵 ${r.units}</span><span>资源 ${r.stock}</span><span>击杀 ${r.kills}</span><span>基地 ${r.baseHp}/${r.baseMaxHp}</span>${modelTag}${llmTag}</div>
        </div>
      </div>`;
    }).join('');

    if (state.lastResult) {
      const t = state.lastResult.winType === 'conquest' ? '征服胜利' : '领土胜利';
      $('rankNote').textContent = `上一局：${state.lastResult.winner} ${t}（T${state.lastResult.turn}）· ▲▼ 为相对上一回合的名次变化。`;
    }
  }

  function renderRecords() {
    const rec = state && state.records;
    if (!rec) return;
    const order = AIS.slice().sort((a, b) => {
      const ra = rec[a] || {}, rb = rec[b] || {};
      return (rb.wins || 0) - (ra.wins || 0) || (rb.territory || 0) - (ra.territory || 0);
    });
    $('recordBody').innerHTML = order.map(ai => {
      const r = rec[ai] || { games: 0, wins: 0, territory: 0 };
      const rate = r.games ? `${Math.round(r.wins / r.games * 100)}%` : '—';
      const avg = r.games ? Math.round(r.territory / r.games).toLocaleString() : '—';
      return `<tr><td style="color:${FACTION_COLOR[ai]}">${ai}</td><td>${r.games}</td><td>${r.wins}</td><td>${rate}</td><td>${avg}</td></tr>`;
    }).join('');
  }

  /* ---------------- 学习记忆 ---------------- */

  let memView = null;
  let memAi = 'A';
  let memSig = '';

  function renderMemory(mem) {
    if (!mem || typeof mem !== 'object') return;
    memView = mem;
    const fb = state && state.feedback ? state.feedback[memAi] : '';
    $('memFeedback').textContent = fb
      ? `本局上回合模型看到的反馈：${fb}`
      : '本局还没产生回合反馈；跑一回合后这里会显示模型收到的 Δ。';

    // 每回合都收到同一份记忆时不要重建列表（会打断滚动），只有内容/选中势力变了才重绘
    const sig = `${memAi}|${JSON.stringify(mem)}`;
    if (sig === memSig) return;
    memSig = sig;

    $('memTag').textContent = mem.enabled ? `累计 ${mem.totalMatches || 0} 局` : '注入已关闭';
    $('memEnabled').checked = !!mem.enabled;
    $('memReflect').checked = !!mem.reflectEnabled;

    $('memStats').innerHTML = AIS.map(ai => {
      const s = (mem.stats && mem.stats[ai]) || {};
      const sub = s.llmGames ? `${ai} · AI ${s.llmWinRate || 0}%` : `${ai} · 脚本`;
      return `<div class="mem-stat" title="${ai}：累计 ${s.games || 0} 局 / ${s.wins || 0} 胜，其中大模型操控 ${s.llmGames || 0} 局"><b style="color:${FACTION_COLOR[ai]}">${s.winRate || 0}%</b><span>${sub}</span></div>`;
    }).join('');

    $('memTabs').innerHTML = AIS.map(ai => {
      const n = (mem.lessons && mem.lessons[ai]) ? mem.lessons[ai].length : 0;
      return `<button data-ai="${ai}" class="${ai === memAi ? 'on' : ''}">${ai} · ${n}</button>`;
    }).join('');
    $('memTabs').querySelectorAll('button').forEach(b => {
      b.onclick = () => { memAi = b.dataset.ai; memSig = ''; renderMemory(memView); };
    });

    const list = (mem.lessons && mem.lessons[memAi]) || [];
    $('memLessons').innerHTML = list.length
      ? list.map(l => {
          const kind = l.kind === 'llm' ? '模型复盘' : (l.kind === 'manual' ? '手记' : '自动复盘');
          const eff = l.uses ? `注入 ${l.uses} 次 / 胜 ${l.winAfter}` : '尚未注入';
          return `<div class="mem-item"><div class="mi-top">
            <span class="mem-kind ${esc(l.kind || 'rule')}">${kind}</span>
            <span class="mem-uses">${eff}</span>
            <button class="mem-del" data-id="${esc(l.id)}" title="删除这条经验">×</button>
          </div><div>${esc(l.text)}</div></div>`;
        }).join('')
      : '<div class="mem-empty">这家还没有经验。跑完一局大模型对局会自动复盘，也可以点「让模型复盘上一局」。</div>';
    $('memLessons').querySelectorAll('.mem-del').forEach(b => {
      b.onclick = async () => {
        const r = await api('/api/memory/lesson', { action: 'remove', ai: memAi, id: b.dataset.id });
        if (r && r.ok !== false) { memSig = ''; renderMemory(r); }
      };
    });

    $('btnMemReflect').disabled = !mem.lastMatch;
    $('btnMemReflect').title = mem.lastMatch
      ? `复盘上一局：${mem.lastMatch.winner} 获胜（T${mem.lastMatch.turn}）`
      : '先跑完一整局再复盘';
  }

  /* ---------------- API ---------------- */

  async function api(path, body = {}) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return { ok: false };
    }
  }

  document.getElementById('btnNew').onclick = async () => {
    await api('/api/stop');
    eventLog = [];
    lastLoggedTurn = -1;
    const r = await api('/api/new', {
      seed: Math.floor(Math.random() * 1e6), cfg: params, controllers: controllersUI,
    });
    if (r.ok) { userMoved = false; layout(); }
  };

  document.getElementById('btnStep').onclick = () => api('/api/step');

  document.getElementById('btnAuto').onclick = () => {
    const interval = Number(document.getElementById('speed').value) || 260;
    api('/api/auto', {
      interval, seed: Math.floor(Math.random() * 1e6), cfg: params, controllers: controllersUI,
    });
  };

  document.getElementById('btnStop').onclick = () => api('/api/stop');
  document.getElementById('btnFit').onclick = e => { e.preventDefault(); fitView(); };
  document.getElementById('btnReset').onclick = e => { e.preventDefault(); resetParams(); };

  $('btnLlmSave').onclick = () => saveProfile();
  $('btnLlmTest').onclick = () => testLlm();
  $('btnLlmClear').onclick = () => clearLlm();
  $('llmProvider').onchange = () => {
    const p = presets.find(x => x.key === $('llmProvider').value);
    if (p) { $('llmBase').value = p.baseURL; $('llmModel').value = p.model; }
  };
  $('llmKey').onkeydown = e => { if (e.key === 'Enter') saveProfile(); };
  $('llmName').onkeydown = e => { if (e.key === 'Enter') saveProfile(); };

  /* ---------------- 学习记忆交互 ---------------- */

  const memHint = text => { $('memHint').textContent = text; };

  $('memEnabled').onchange = async () => {
    const on = $('memEnabled').checked;
    const r = await api('/api/memory/config', { enabled: on });
    if (r && r.ok !== false) { memSig = ''; renderMemory(r); }
    memHint(on
      ? '已开启：下回合起把战绩、败因与经验一起发给模型。'
      : '已关闭：模型只看当前局面，战绩仍会照常累计。');
  };
  $('memReflect').onchange = async () => {
    const on = $('memReflect').checked;
    const r = await api('/api/memory/config', { reflectEnabled: on });
    if (r && r.ok !== false) { memSig = ''; renderMemory(r); }
    memHint(on
      ? '已开启：每局结束从数据自动提炼经验，不调用模型、不产生费用。'
      : '已关闭：不再自动生成经验，仍可手动复盘。');
  };
  $('btnMemReflect').onclick = async () => {
    const btn = $('btnMemReflect');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '复盘中…';
    const r = await api('/api/memory/reflect', { ai: memAi });
    btn.disabled = false; btn.textContent = label;
    memHint(r && r.ok
      ? `已用 ${r.model || '模型'} 为 ${r.ai} 写入 ${(r.added || []).length} 条经验。`
      : `复盘失败：${(r && r.error) || '没有可用模型或已结束的对局'}`);
    if (r && r.ok) { memSig = ''; renderMemory(r); }
  };
  $('btnMemClear').onclick = async () => {
    if (!window.confirm('清空所有历史战绩与经验？此操作不可撤销。')) return;
    const r = await api('/api/memory/clear');
    if (r && r.ok) { memSig = ''; renderMemory(r); memHint('记忆已清空，下一局重新开始累计。'); }
  };

  /* ---------------- 启动 ---------------- */

  new ResizeObserver(() => layout()).observe(wrap);
  requestAnimationFrame(() => layout());
  drawLegend();
  drawTrend();

  if (!state) {
    fetch('/api/state').then(r => r.json()).then(d => {
      if (d.ok && d.game && !state) onState(d.game);
    }).catch(() => {});
  }

  const getJson = url => fetch(url).then(r => r.json()).catch(() => ({ ok: false }));
  Promise.all([getJson('/api/config'), getJson('/api/llm/config'), getJson('/api/memory')]).then(([c, l, m]) => {
    if (c.mapW) { mapW = c.mapW; mapH = c.mapH; }
    if (Array.isArray(c.providers)) presets = c.providers;
    if (Array.isArray(c.styles) && c.styles.length) styleOptions = c.styles;
    if (c.defaults) buildParams(c);
    if (l.ok) renderLlmInfo(l);
    else { renderProfiles(); refreshControllerOptions(); }
    initControllers(l.controllers);
    refreshControllerOptions();
    if (m && m.ok) renderMemory(m);
    layout();
  }).catch(() => {});
})();
