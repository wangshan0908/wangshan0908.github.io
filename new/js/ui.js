/**
 * ui.js —— 渲染层（总览 + 详情）
 *
 * 渲染策略：
 *   总览  每次整体重绘（卡片是纯展示，没有输入控件）
 *   详情  只建一次骨架，之后按 data-k 局部更新文本
 *          —— 否则每 120ms 一次重绘会把按钮点击、曲线交互全冲掉
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});
  const S = TP.store;

  let root = null;
  let routeKey = '';
  let chartMetric = '';

  // ============================================================
  // 工具
  // ============================================================

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function nf(v, n) {
    if (v == null || !isFinite(v)) return '--';
    return Number(v).toFixed(n == null ? 1 : n);
  }

  function watt(w) {
    if (w == null || !isFinite(w)) return '--';
    return w >= 1000 ? nf(w / 1000, 2) + ' kW' : nf(w, 0) + ' W';
  }

  function ago(ms) {
    if (!ms) return '--';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return Math.floor(s) + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function hhmm(sec) {
    const d = new Date(sec * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  const BADGE = {
    online: ['on', '在线'],
    stale: ['warn', '无数据'],
    offline: ['off', '离线'],
    unknown: ['unk', '待连接'],
  };

  function badgeHtml(d) {
    const b = BADGE[S.badge(d)] || BADGE.unknown;
    return `<span class="dot ${b[0]}"></span><span class="btxt">${b[1]}</span>`;
  }

  function icon(role) {
    return role === 'bms' ? '🔋' : '☀️';
  }

  function typeName(d) {
    if (d.role === 'bms') return '电池 BMS';
    if (d.role === 'mppt') return 'MPPT 控制器';
    return '未知设备';
  }

  // ============================================================
  // 迷你曲线（SVG，总览卡片用）
  // ============================================================

  function sparkline(pts, w, h) {
    if (!pts || pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
    const xs = pts.map(p => p.t);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const span = Math.max(1, t1 - t0);
    const vals = pts.map(p => p.v);
    let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1e-6) { max += 1; min -= 1; }
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;

    const path = pts.map((p, i) => {
      const x = ((p.t - t0) / span) * (w - 2) + 1;
      const y = h - 2 - ((p.v - min) / (max - min)) * (h - 4);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');

    const area = path + ` L${(w - 1).toFixed(1)} ${h} L1 ${h} Z`;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path class="spark-area" d="${area}"></path>
      <path class="spark-line" d="${path}"></path>
    </svg>`;
  }

  // ============================================================
  // 总览
  // ============================================================

  function cardHtml(d) {
    const b = S.badge(d);
    const isBms = d.role === 'bms';
    const f = d.d;

    let big = '--', bigUnit = '', sub = '';
    const rows = [];

    if (isBms) {
      if (f) {
        big = nf(f.soc, 0); bigUnit = '%';
        sub = f.charging ? '充电中' : (f.discharging ? '放电中' : (f.full ? '已充满' : '静置'));
        rows.push(['总压', nf(f.pack_v, 2) + ' V']);
        rows.push(['电流', nf(f.pack_a, 2) + ' A']);
        rows.push(['温度', nf(f.t1, 0) + '°C']);
        rows.push(['压差', nf(f.cell_diff_mv, 0) + ' mV']);
      }
    } else {
      if (f) {
        big = watt(f.pv_w).replace(/ (W|kW)$/, '');
        bigUnit = (watt(f.pv_w).match(/W|kW/) || ['W'])[0];
        sub = f.fault ? '故障' : (f.chg_code === 1 ? '充电中' : (f.chg_code === 2 ? '已充满' : (f.night ? '夜间' : '待机')));
        rows.push(['PV', nf(f.pv_v, 1) + ' V']);
        rows.push(['电池', nf(f.bat_v, 2) + ' V']);
        rows.push(['电量', nf(f.soc, 0) + ' %']);
        rows.push(['负载', f.load_on ? watt(f.load_w) : '关']);
      }
    }

    const pts = (d.hist || []).slice(-40).map(p => ({ t: p.t, v: isBms ? p.soc : p.pv_w }))
      .filter(p => typeof p.v === 'number');

    return `<a class="card ${b}" href="#/d/${encodeURIComponent(d.id)}">
      <div class="card-top">
        <span class="cicon">${icon(d.role)}</span>
        <span class="cname">${esc(d.name || d.id)}</span>
        <span class="cbadge">${badgeHtml(d)}</span>
      </div>
      <div class="card-site">${esc(d.site || typeName(d))}<span class="cmodel">${esc(
          (d.meta && d.meta.model) || d.pk || '')}</span></div>
      <div class="card-main">
        <div class="big">${esc(big)}<i>${esc(bigUnit)}</i></div>
        <div class="bigsub">${esc(sub)}</div>
      </div>
      ${sparkline(pts, 120, 34)}
      <div class="card-rows">
        ${rows.map(r => `<div><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}
      </div>
      <div class="card-foot">
        <span>${f ? ago(d.rxTs) : '暂无数据'}</span>
        <span>${f ? 'seq ' + f.seq : ''}</span>
      </div>
    </a>`;
  }

  function updateOverview() {
    const sum = S.summary();
    const list = S.list();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('kOn', sum.on + '/' + sum.total);
    set('kWh', nf(sum.whToday, 1));
    set('kMppt', sum.mppt);
    set('kBms', sum.bms);

    const box = document.getElementById('list');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="empty">
        <p>还没有收到任何设备。</p>
        <p class="small">设备上电后会发一条 retained 的 meta，这里就会自动出现。
        如果你还没改固件，旧主题（/mppt/data1）不会出现在这个页面。</p>
      </div>`;
      return;
    }
    box.innerHTML = list.map(cardHtml).join('');
  }

  // ============================================================
  // 详情：骨架
  // ============================================================

  const MPPT_KV = [
    ['pv_v', '光伏电压', 'V', 2],
    ['pv_a', '光伏电流', 'A', 2],
    ['bat_v', '电池电压', 'V', 2],
    ['bat_a', '电池电流', 'A', 2],
    ['load_a', '负载电流', 'A', 2],
    ['load_w', '负载功率', 'W', 0],
    ['bat_t', '电池温度', '°C', 0],
    ['buck_t', 'BUCK 温度', '°C', 0],
    ['soc', '电池电量', '%', 0],
    ['wh_today', '今日发电', 'kWh', 2],
    ['wh_total', '累计发电', 'kWh', 1],
    ['pv_max_w', '最大充电功率', 'W', 0],
  ];

  const BMS_KV = [
    ['pack_v', '总电压', 'V', 3],
    ['pack_a', '电流', 'A', 2],
    ['remain_mah', '剩余容量', 'mAh', 0],
    ['soh', '健康度 SOH', '%', 0],
    ['cell_diff_mv', '单体压差', 'mV', 0],
    ['mos_t', 'MOS 温度', '°C', 0],
    ['cycles', '循环次数', '次', 0],
    ['alarm_level', '告警等级', '', 0],
  ];

  function kvRows(tab) {
    return tab.map(r => `<div class="kv"><span>${r[1]}</span><b data-k="${r[0]}">--</b><i>${r[2]}</i></div>`).join('');
  }

  function skeletonDetail() {
    return `<div class="detail">
      <div class="dhead">
        <a class="back" href="#/">‹ 返回</a>
        <div class="dtitle"><span data-k="dname">设备</span>
          <span class="cbadge" data-k="dbadge"></span></div>
        <div class="dsub" data-k="dsub"></div>
      </div>

      <div class="badges" data-k="chips"></div>

      <div class="kpis">
        <div class="kpi"><b data-k="k1">--</b><span data-k="k1l"></span></div>
        <div class="kpi"><b data-k="k2">--</b><span data-k="k2l"></span></div>
        <div class="kpi"><b data-k="k3">--</b><span data-k="k3l"></span></div>
        <div class="kpi"><b data-k="k4">--</b><span data-k="k4l"></span></div>
      </div>

      <div class="panel" data-k="chartPanel">
        <div class="phead">
          <span>曲线</span>
          <span class="tabs" data-k="tabs"></span>
        </div>
        <canvas id="chart" class="chart"></canvas>
        <div class="chart-foot" data-k="chartFoot"></div>
      </div>

      <div class="panel" data-k="cellsPanel" hidden>
        <div class="phead"><span>单体电压</span><span data-k="cellInfo"></span></div>
        <div class="cells" data-k="cells"></div>
      </div>

      <div class="panel">
        <div class="phead"><span>实时参数</span><span data-k="rxInfo"></span></div>
        <div class="kvbox" data-k="kv"></div>
      </div>

      <div class="panel" data-k="metaPanel">
        <div class="phead"><span>设备档案</span></div>
        <div class="kvbox wide" data-k="meta"></div>
      </div>

      <div class="panel">
        <div class="phead"><span>控制</span><span class="small" data-k="cmdHint"></span></div>
        <div class="btns" data-k="btns"></div>
      </div>

      <div class="panel">
        <div class="phead"><span>事件</span><span class="small">最近 30 条</span></div>
        <div class="events" data-k="events"></div>
      </div>
    </div>`;
  }

  function setK(id, val, label) {
    const e = document.querySelector(`[data-k="${id}"]`);
    if (e) e.textContent = val;
    if (label != null) {
      const l = document.querySelector(`[data-k="${id}l"]`);
      if (l) l.textContent = label;
    }
  }

  function chips(list) {
    return list.filter(Boolean).map(c => `<span class="chip ${c[1] || ''}">${esc(c[0])}</span>`).join('');
  }

  // ============================================================
  // 详情：更新
  // ============================================================

  function updateDetail(id) {
    const d = S.get(id);
    const head = document.querySelector('.dhead');
    if (!d) {
      if (head) head.innerHTML = `<a class="back" href="#/">‹ 返回</a><div class="dtitle">设备 ${esc(id)} 未找到</div>`;
      return;
    }

    // ---- 头部 ----
    const dn = document.querySelector('[data-k="dname"]');
    if (dn) dn.textContent = (d.role === 'bms' ? '🔋 ' : '☀️ ') + (d.name || d.id);
    const db = document.querySelector('[data-k="dbadge"]');
    if (db) db.innerHTML = badgeHtml(d);
    const dsub = document.querySelector('[data-k="dsub"]');
    if (dsub) {
      const bits = [typeName(d), d.site, d.meta && d.meta.model, d.fw ? 'FW ' + d.fw : ''].filter(Boolean);
      dsub.textContent = bits.join(' · ');
    }

    // ---- 状态徽章 ----
    const chipBox = document.querySelector('[data-k="chips"]');
    const f = d.d;
    if (chipBox) {
      if (!f) {
        chipBox.innerHTML = `<span class="chip">等待第一帧数据</span>`;
      } else if (f.type === 'bms') {
        chipBox.innerHTML = chips([
          f.charging ? ['充电中', 'ok'] : null,
          f.discharging ? ['放电中', 'ok'] : null,
          f.full ? ['已充满', 'info'] : null,
          f.balance ? ['均衡中', 'info'] : null,
          f.allow_dis ? null : ['禁止放电', 'bad'],
          f.genuine ? null : ['非原装', 'warn'],
          f.alarm_level ? ['告警等级 ' + f.alarm_level, 'bad'] : null,
          f.alarm ? ['告警码 0x' + f.alarm.toString(16).padStart(2, '0'), 'warn'] : null,
        ]);
      } else {
        chipBox.innerHTML = chips([
          f.chg_code === 1 ? ['充电中', 'ok'] : null,
          f.chg_code === 2 ? ['已充满', 'info'] : null,
          f.chg_code === 3 ? ['充电故障', 'bad'] : null,
          f.chg_code === 0 ? ['未充电', ''] : null,
          f.load_on ? ['负载开', 'ok'] : ['负载关', ''],
          f.night ? ['夜间', 'info'] : null,
          f.fan ? ['风机运行', ''] : null,
          f.comm_err ? ['通讯异常', 'warn'] : null,
          f.fault ? ['故障', 'bad'] : null,
        ]);
      }
    }

    // ---- 四个大数 ----
    if (f && f.type === 'bms') {
      setK('k1', nf(f.soc, 0), '电量 %');
      setK('k2', nf(f.pack_v, 2), '总电压 V');
      setK('k3', nf(f.pack_a, 2), '电流 A');
      setK('k4', nf(f.t1, 0), '温度 °C');
    } else if (f) {
      setK('k1', watt(f.pv_w).replace(/ (W|kW)/, ''), '光伏功率 ' + (f.pv_w >= 1000 ? 'kW' : 'W'));
      setK('k2', nf(f.bat_v, 2), '电池电压 V');
      setK('k3', nf(f.soc, 0), '电量 %');
      setK('k4', nf(f.wh_today, 2), '今日发电 kWh');
    } else {
      setK('k1', '--', ''); setK('k2', '--', ''); setK('k3', '--', ''); setK('k4', '--', '');
    }

    // ---- KV ----
    const kv = document.querySelector('[data-k="kv"]');
    if (kv && !kv.dataset.built) {
      kv.innerHTML = kvRows(f && f.type === 'bms' ? BMS_KV : MPPT_KV);
      kv.dataset.built = '1';
    }
    if (kv && f) {
      const tab = f.type === 'bms' ? BMS_KV : MPPT_KV;
      for (const r of tab) {
        const el = document.querySelector(`[data-k="${r[0]}"]`);
        if (el) el.textContent = nf(f[r[0]], r[3]);
      }
    }

    // ---- 单体电压 ----
    const cp = document.querySelector('[data-k="cellsPanel"]');
    if (cp) {
      if (f && f.type === 'bms' && f.cells_mv && f.cells_mv.length) {
        // 协议固定打包 8 节，实际串数看 cell_num；多出来的 0 会让压差算成 3400mV+
        const n = (f.cell_num > 0 && f.cell_num <= f.cells_mv.length) ? f.cell_num : f.cells_mv.length;
        const cells = f.cells_mv.slice(0, n).filter(mv => mv > 0);
        if (!cells.length) {
          cp.hidden = true;
        } else {
        cp.hidden = false;
        const lo = Math.min.apply(null, cells), hi = Math.max.apply(null, cells);
        // 压差往往只有几 mV，若按 hi-lo 拉满，柱子会几乎等高看不出差异。
        // 这里保证至少 10mV 的视觉跨度，且最小值落在 25% 高度附近。
        const span = Math.max(hi - lo, 10);
        const base = lo - span * 0.35;
        const top = hi + span * 0.15;
        document.querySelector('[data-k="cellInfo"]').textContent =
          `最高 ${hi} / 最低 ${lo} / 压差 ${hi - lo} mV`;
        document.querySelector('[data-k="cells"]').innerHTML = cells.map((mv, i) => {
          const h = Math.max(4, ((mv - base) / (top - base)) * 100);
          const cls = mv === hi ? 'hi' : (mv === lo ? 'lo' : '');
          return `<div class="cell ${cls}">
            <div class="cwrap"><div class="cbar" style="height:${h.toFixed(1)}%"></div></div>
            <span>${(mv / 1000).toFixed(2)}</span><i>${i + 1}</i></div>`;
        }).join('');
        }
      } else {
        cp.hidden = true;
      }
    }

    // ---- 档案 ----
    const mp = document.querySelector('[data-k="meta"]');
    if (mp) mp.innerHTML = metaRows(d);

    // ---- 数据新鲜度 ----
    const rx = document.querySelector('[data-k="rxInfo"]');
    if (rx) {
      rx.textContent = d.rxTs
        ? `${ago(d.rxTs)} · 帧 ${d.frames}${d.lost ? ' · 丢 ' + d.lost : ''}${d.bad ? ' · 坏帧 ' + d.bad : ''}`
        : '暂无数据';
    }

    // ---- 曲线 ----
    if (!chartMetric) chartMetric = f && f.type === 'bms' ? 'soc' : 'pv_w';
    renderChart(d);

    // ---- 命令按钮 ----
    const btns = document.querySelector('[data-k="btns"]');
    const hint = document.querySelector('[data-k="cmdHint"]');
    const sig = (f ? f.type : 'x') + '|' + S.badge(d);
    if (btns && btns.dataset.sig !== sig) {
      btns.dataset.sig = sig;
      btns.innerHTML = btnHtml(d);
    }
    if (hint) hint.textContent = d.ack
      ? `上次：${d.ack.ok ? '成功' : '失败'} ${d.ack.m || ''} ${ago(d.ack.ts)}`
      : '';

    // ---- 事件 ----
    const ev = document.querySelector('[data-k="events"]');
    if (ev) ev.innerHTML = eventsHtml(d);
  }

  function metaRows(d) {
    const m = d.meta;
    const isBms = d.role === 'bms' || (d.d && d.d.type === 'bms');
    const rows = [];
    rows.push(['设备编号', d.id]);
    rows.push(['产品型号段', d.pk || '--']);
    if (m) {
      if (m.model) rows.push([isBms ? '电池型号' : '控制器型号', m.model]);
      if (m.sw != null) rows.push(['软件版本', String(m.sw)]);
      if (m.hw != null) rows.push(['硬件版本', String(m.hw)]);
      if (m.ov != null) rows.push(['过压保护', nf(m.ov, 1) + ' V']);
      if (m.uv != null) rows.push(['欠压保护', nf(m.uv, 1) + ' V']);
      if (m.aux) rows.push(['辅源启停', nf(m.aux[0], 2) + ' / ' + nf(m.aux[1], 2) + ' V']);
      if (m.gridv != null) rows.push(['直流侧电压', nf(m.gridv, 2) + ' V']);
      if (m.btype != null) rows.push(['电池类型', String(m.btype)]);
      if (m.lr != null) rows.push(['负载恢复回差', m.lr + ' mV']);
      if (m.rc != null) rows.push(['再充压差', m.rc + ' mV']);
      if (m.cell_type != null) rows.push(['电芯类型', String(m.cell_type)]);
      if (m.design_mah != null) rows.push(['设计容量', m.design_mah + ' mAh']);
      if (m.fcc_mah != null) rows.push(['满充容量', m.fcc_mah + ' mAh']);
    }
    rows.push(['档案时间', ago(d.metaRx)]);
    return rows.map(r => `<div class="kv"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('');
  }

  function btnHtml(d) {
    const f = d.d;
    const isBms = (f && f.type === 'bms') || d.role === 'bms';
    const b = S.badge(d);
    const off = (b === 'offline') ? 'disabled' : '';

    if (isBms) {
      return `<button data-cmd="turbo" ${off}>3 秒快报 ${TP.CFG.turboSec / 60} 分钟</button>
              <button data-cmd="read" ${off}>立即读取</button>
              <button data-cmd="meta" ${off}>刷新档案</button>
              <button data-cmd="reboot" class="danger" ${off}>重启设备</button>`;
    }
    const on = f && f.load_on;
    return `<button data-cmd="load" data-v="1" class="${on ? '' : 'primary'}" ${off}>打开负载</button>
            <button data-cmd="load" data-v="0" class="${on ? 'primary' : ''}" ${off}>关闭负载</button>
            <button data-cmd="turbo" ${off}>3 秒快报 ${TP.CFG.turboSec / 60} 分钟</button>
            <button data-cmd="read" ${off}>立即读取</button>
            <button data-cmd="reboot" class="danger" ${off}>重启设备</button>`;
  }

  const EV_TEXT = {
    boot: ['启动', ''],
    online: ['上线', 'ok'],
    offline: ['离线', 'off'],
    tx: ['流量统计', ''],
    mb_err: ['Modbus 异常', 'warn'],
    ack: ['命令回执', 'info'],
    meta: ['档案更新', ''],
    bad: ['坏帧', 'bad'],
  };

  function eventsHtml(d) {
    const list = (d.events || []).slice().reverse().slice(0, 20);
    if (!list.length) return `<div class="empty small">还没有事件</div>`;
    return list.map(e => {
      const t = EV_TEXT[e.t] || [e.t, ''];
      let detail = '';
      if (e.t === 'tx') detail = `累计 ${(e.b / 1024).toFixed(1)} KB · ${e.f} 帧 · 超时 ${e.to || 0}`;
      else if (e.t === 'mb_err') detail = `累计 ${e.n} 次`;
      else if (e.t === 'ack') detail = `${e.id || ''} ${e.ok === 1 ? '成功' : '失败'} ${e.m || ''}`;
      else if (e.t === 'offline') detail = e.w === 'lwt' ? '遗嘱触发' : '';
      else if (e.t === 'boot') detail = e.fw ? 'FW ' + e.fw : '';
      return `<div class="ev ${t[1]}"><span class="evt">${hhmm(e.ts > 1e10 ? Math.floor(e.ts / 1000) : (e.ts || 0))}</span>
        <span class="evn">${esc(t[0])}</span><span class="evd">${esc(detail)}</span></div>`;
    }).join('');
  }

  // ============================================================
  // 曲线
  // ============================================================

  const METRICS = {
    pv_w: ['功率', 'W', 0],
    pv_v: ['PV 电压', 'V', 1],
    pv_a: ['PV 电流', 'A', 2],
    soc: ['电量', '%', 0],
    bat_v: ['电池电压', 'V', 2],
    bat_a: ['电池电流', 'A', 2],
    load_w: ['负载功率', 'W', 0],
    pack_v: ['总电压', 'V', 2],
    pack_a: ['电流', 'A', 2],
    diff: ['压差', 'mV', 0],
  };

  function metricsFor(d) {
    const f = d.d;
    const isBms = (f && f.type === 'bms') || d.role === 'bms';
    return isBms ? ['soc', 'pack_a', 'pack_v', 'diff'] : ['pv_w', 'pv_v', 'pv_a', 'soc'];
  }

  function renderChart(d) {
    const tabs = document.querySelector('[data-k="tabs"]');
    const avail = metricsFor(d);
    if (!avail.includes(chartMetric)) chartMetric = avail[0];
    if (tabs) {
      tabs.innerHTML = avail.map(k =>
        `<button class="tab ${k === chartMetric ? 'on' : ''}" data-metric="${k}">${METRICS[k][0]}</button>`
      ).join('');
    }

    const cv = document.getElementById('chart');
    const foot = document.querySelector('[data-k="chartFoot"]');
    if (!cv) return;

    const pts = (d.hist || []).filter(p => typeof p[chartMetric] === 'number');
    const [, unit, dec] = METRICS[chartMetric];

    if (pts.length < 2) {
      const ctx = cv.getContext('2d');
      const w = cv.clientWidth || 300, h = cv.clientHeight || 140;
      cv.width = w; cv.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted') || '#888';
      ctx.font = '12px system-ui';
      ctx.fillText('数据点不足，先跑一会儿（或点「3 秒快报」）', 8, h / 2);
      if (foot) foot.textContent = '';
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300;
    const h = cv.clientHeight || 140;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.body);
    const cLine = css.getPropertyValue('--accent').trim() || '#0ea5e9';
    const cGrid = css.getPropertyValue('--line').trim() || '#e5e7eb';
    const cMuted = css.getPropertyValue('--muted').trim() || '#6b7280';

    const padL = 6, padR = 6, padT = 10, padB = 16;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const span = Math.max(1, t1 - t0);
    let vmin = Infinity, vmax = -Infinity;
    for (const p of pts) {
      const v = p[chartMetric];
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    if (vmax - vmin < 1e-6) { vmax += 1; vmin -= 1; }
    const pad = (vmax - vmin) * 0.15;
    vmin -= pad; vmax += pad;

    const X = t => padL + ((t - t0) / span) * (w - padL - padR);
    const Y = v => h - padB - ((v - vmin) / (vmax - vmin)) * (h - padT - padB);

    // 网格（3 条横线）
    ctx.strokeStyle = cGrid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i <= 3; i++) {
      const y = padT + (i * (h - padT - padB)) / 3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 折线 + 面积
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t), y = Y(p[chartMetric]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = cLine;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(X(pts[pts.length - 1].t), h - padB);
    ctx.lineTo(X(pts[0].t), h - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, cLine + '44');
    grad.addColorStop(1, cLine + '05');
    ctx.fillStyle = grad;
    ctx.fill();

    // 末点
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(X(last.t), Y(last[chartMetric]), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = cLine;
    ctx.fill();

    // 轴标签
    ctx.fillStyle = cMuted;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(nf(vmax - pad, dec) + ' ' + unit, padL, padT - 1);
    ctx.fillText(nf(vmin + pad, dec), padL, h - padB + 12);
    ctx.textAlign = 'right';
    ctx.fillText(hhmm(t1), w - padR, h - padB + 12);

    if (foot) {
      foot.textContent = `${pts.length} 点 · ${hhmm(t0)} → ${hhmm(t1)} · 最新 ${nf(last[chartMetric], dec)} ${unit}`;
    }
  }

  // ============================================================
  // 汇总
  // ============================================================

  function skeletonOverview() {
    return `<div class="overview">
      <div class="summary">
        <div class="kpi"><b id="kOn">--</b><span>在线设备</span></div>
        <div class="kpi"><b id="kWh">--</b><span>今日发电 kWh</span></div>
        <div class="kpi"><b id="kMppt">--</b><span>光伏控制器</span></div>
        <div class="kpi"><b id="kBms">--</b><span>电池组</span></div>
      </div>
      <div class="grid" id="list"></div>
    </div>`;
  }

  // ============================================================
  // 入口
  // ============================================================

  function parseRoute() {
    const h = (location.hash || '#/').trim();
    const m = h.match(/^#\/d\/(.+)$/);
    if (m) return { name: 'detail', id: decodeURIComponent(m[1]) };
    return { name: 'overview' };
  }

  function render() {
    if (!root) return;
    const r = parseRoute();
    const key = r.name + ':' + (r.id || '');
    if (key !== routeKey) {
      routeKey = key;
      chartMetric = '';
      root.innerHTML = r.name === 'detail' ? skeletonDetail() : skeletonOverview();
    }
    if (r.name === 'detail') updateDetail(r.id);
    else updateOverview();
  }

  function mount(el) {
    root = el;

    // 路由变化
    window.addEventListener('hashchange', () => {
      routeKey = '';
      window.scrollTo(0, 0);
      render();
    });

    // 曲线指标切换 + 命令按钮（事件委托，避免重绘后失效）
    root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-metric]');
      if (tab) {
        chartMetric = tab.dataset.metric;
        const r = parseRoute();
        const d = S.get(r.id);
        if (d) renderChart(d);
        document.querySelectorAll('.tab').forEach(t =>
          t.classList.toggle('on', t.dataset.metric === chartMetric));
        return;
      }

      const btn = e.target.closest('[data-cmd]');
      if (btn) {
        const r = parseRoute();
        const d = S.get(r.id);
        if (!d) return;
        onCmd(d, btn.dataset.cmd, btn.dataset.v, btn);
      }
    });

    // 窗口变化时重绘曲线（canvas 需要按新宽度重新算）
    let rz = null;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        const r = parseRoute();
        if (r.name === 'detail') {
          const d = S.get(r.id);
          if (d) renderChart(d);
        }
      }, 200);
    });

    render();
  }

  /** 命令按钮处理（实际发送由 app.js 注入，避免 ui 依赖网络层） */
  function onCmd(d, cmd, val, btn) {
    if (cmd === 'reboot') {
      if (!confirm(`确定重启「${d.name || d.id}」？\n设备会断线约 20 秒，重启期间没有数据。`)) return;
    }
    if (cmd === 'load') {
      const want = val === '1';
      if (!confirm(`确定${want ? '打开' : '关闭'}「${d.name || d.id}」的负载？\n这会立刻改变现场输出。`)) return;
    }
    if (typeof TP.sendCmd !== 'function') {
      toast('连接层还没就绪');
      return;
    }
    btn.disabled = true;
    TP.sendCmd(d, cmd, cmd === 'load' ? { v: Number(val) } : (cmd === 'turbo' ? { sec: TP.CFG.turboSec } : {}))
      .then((ok) => toast(ok ? '命令已发送' : '发送失败，检查连接'))
      .finally(() => { btn.disabled = false; });
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  TP.ui = { mount, render, toast };

})(typeof globalThis !== 'undefined' ? globalThis : this);
