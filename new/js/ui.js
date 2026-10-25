/**
 * ui.js —— 所有 DOM 渲染
 *
 * 全部用模板字符串 + 事件委托，不引任何框架。
 */
(function (global) {
  'use strict';

  const TP = global.TP;
  const CFG = TP.CFG;
  const store = TP.store;

  // ---------- 小工具 ----------

  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.from((root || document).querySelectorAll(sel)); };
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  TP.$ = $;
  TP.$$ = $$;

  const fmt = {
    num(v, d = 1) { return (v == null || !isFinite(v)) ? '--' : Number(v).toFixed(d); },
    pct(v) { return (v == null || !isFinite(v)) ? '--' : Number(v).toFixed(0) + '%'; },
    v(v) { return fmt.num(v, 2); },
    a(v) { return fmt.num(v, 2); },
    w(v) { return fmt.num(v, 1); },
    wh(v) { return v == null || !isFinite(v) ? '--' : (v / 1000).toFixed(2) + ' kWh'; },
    dt(ts) {
      if (!ts) return '--';
      const d = new Date(ts);
      return d.toTimeString().slice(0, 8);
    },
    t(ts) {
      if (!ts) return '--';
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
  };

  // ---------- 设备卡片 ----------

  function onlineOf(devId, d) {
    const st = d && d.status;
    const last = d && d.lastState;
    if (st && st.online === true) {
      if (last && Date.now() - last.ts > CFG.offlineSec * 1000) return 'offline';
      if (last && Date.now() - last.ts > CFG.warnSec * 1000) return 'stale';
      return 'online';
    }
    if (st && st.online === false) return 'offline';
    return 'unknown';
  }

  function cardHtml(devId, d) {
    const st = onlineOf(devId, d);
    const m = d.meta || {};
    const s = d.lastState || null;
    const model = m.model || '--';

    let big = '--', bigUnit = '', bigSub = '', rows = '';
    if (s) {
      if (s.type === 'mppt') {
        big = fmt.w(s.pv_w); bigUnit = 'W';
        bigSub = `电池 ${fmt.v(s.bat_v)}V · ${fmt.pct(s.soc)}`;
        rows = [
          ['光伏', `${fmt.v(s.pv_v)}V / ${fmt.a(s.pv_a)}A`],
          ['电池', `${fmt.a(s.bat_a)}A`],
          ['负载', `${fmt.w(s.load_w)}W / ${fmt.a(s.load_a)}A`],
          ['今日', fmt.wh(s.wh_today)],
        ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
      } else if (s.type === 'bms') {
        big = fmt.v(s.pack_v); bigUnit = 'V';
        bigSub = `${fmt.pct(s.soc)} · ${fmt.pct(s.soh)} SOH`;
        rows = [
          ['电流', `${fmt.a(s.pack_a)}A`],
          ['单体', `${(s.cell_max_mv / 1000).toFixed(3)}~${(s.cell_min_mv / 1000).toFixed(3)}V`],
          ['压差', `${(s.cell_diff_mv / 1000).toFixed(3)}V`],
          ['循环', String(s.cycles)],
        ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
      }
    }

    const stText = { online: '在线', stale: '待刷新', offline: '离线', unknown: '未知' }[st];
    const dotCls = { online: 'on', stale: 'warn', offline: 'off', unknown: '' }[st];
    const site = m.site || '';

    return `
    <a class="card ${st}" href="#dev/${devId}">
      <div class="card-top">
        <span class="cicon">${s && s.type === 'bms' ? '🔋' : '☀️'}</span>
        <span class="cname">${esc(m.name || devId)}</span>
        <span class="cbadge"><i class="dot ${dotCls}"></i><span class="btxt">${stText}</span></span>
      </div>
      ${site ? `<div class="card-site"><span>📍 ${esc(site)}</span><span class="cmodel">${esc(model)}</span></div>` : ''}
      <div class="card-main"><span class="big">${big}<i>${bigUnit}</i></span><span class="bigsub">${bigSub}</span></div>
      ${s ? sparkSvg(s) : ''}
      <div class="card-rows">${rows}</div>
      <div class="card-foot"><span>${s ? fmt.dt(s.ts) : '--'}</span><span>#${esc(devId)}</span></div>
    </a>`;
  }

  function sparkSvg(s) {
    const pts = (s.type === 'bms' ? [s.pack_v] : [s.pv_w]);
    // 简化：只画一个点，展示占位
    return '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- 列表页 ----------

  function renderList() {
    const list = store.list();
    const view = $('#view');
    if (!view) return;

    // 汇总
    let online = 0, offline = 0, total = list.length, pvW = 0, loadW = 0;
    for (const { d } of list) {
      const st = onlineOf('', d);
      if (st === 'online') online++;
      else if (st === 'offline') offline++;
      const s = d.lastState;
      if (s && s.type === 'mppt') { pvW += s.pv_w; loadW += s.load_w; }
    }

    view.innerHTML = `
      <div class="summary">
        <div class="kpi"><b>${total}</b><span>设备总数</span></div>
        <div class="kpi"><b>${online}</b><span>在线</span></div>
        <div class="kpi"><b>${offline}</b><span>离线</span></div>
        <div class="kpi"><b>${fmt.w(pvW)}<i style="font-size:10px;margin-left:2px">W</i></b><span>光伏功率</span></div>
      </div>
      <div class="grid">
        ${list.length ? list.map(({ id, d }) => cardHtml(id, d)).join('') : '<div class="empty">暂无设备数据<br><span class="small">等待 MQTT 上报…</span></div>'}
      </div>`;
  }

  // ---------- 详情页 ----------

  function renderDetail(devId) {
    const d = store.device(devId);
    const view = $('#view');
    if (!view) return;
    if (!d) { view.innerHTML = '<div class="empty">设备不存在</div>'; return; }

    const m = d.meta || {};
    const s = d.lastState || null;
    const st = onlineOf(devId, d);

    let kpis = '', panels = '';
    if (s) {
      if (s.type === 'mppt') {
        kpis = `
          <div class="kpis">
            <div class="kpi"><b>${fmt.w(s.pv_w)}</b><span>光伏功率 W</span></div>
            <div class="kpi"><b>${fmt.v(s.pv_v)}</b><span>光伏电压 V</span></div>
            <div class="kpi"><b>${fmt.a(s.pv_a)}</b><span>光伏电流 A</span></div>
            <div class="kpi"><b>${fmt.v(s.bat_v)}</b><span>电池电压 V</span></div>
            <div class="kpi"><b>${fmt.pct(s.soc)}</b><span>SOC</span></div>
            <div class="kpi"><b>${fmt.a(s.bat_a)}</b><span>电池电流 A</span></div>
            <div class="kpi"><b>${fmt.w(s.load_w)}</b><span>负载功率 W</span></div>
            <div class="kpi"><b>${fmt.wh(s.wh_today)}</b><span>今日发电</span></div>
          </div>`;
        panels = `
          <div class="panel">
            <div class="phead"><span>实时参数</span></div>
            <div class="kvbox">
              ${kv('充电状态', s.chg)}
              ${kv('负载开关', s.load_on ? '开' : '关')}
              ${kv('电池温度', s.bat_t + '℃')}
              ${kv('BUCK 温度', s.buck_t + '℃')}
              ${kv('风机', s.fan ? '转' : '停')}
              ${kv('夜间模式', s.night ? '是' : '否')}
              ${kv('累计发电', fmt.wh(s.wh_total))}
              ${kv('今日最大功率', fmt.w(s.pv_max_w) + 'W')}
              ${kv('信号 CSQ', String(s.csq))}
            </div>
          </div>`;
      } else if (s.type === 'bms') {
        kpis = `
          <div class="kpis">
            <div class="kpi"><b>${fmt.v(s.pack_v)}</b><span>总压 V</span></div>
            <div class="kpi"><b>${fmt.pct(s.soc)}</b><span>SOC</span></div>
            <div class="kpi"><b>${fmt.pct(s.soh)}</b><span>SOH</span></div>
            <div class="kpi"><b>${fmt.a(s.pack_a)}</b><span>电流 A</span></div>
            <div class="kpi"><b>${(s.cell_max_mv / 1000).toFixed(3)}</b><span>最高单体 V</span></div>
            <div class="kpi"><b>${(s.cell_min_mv / 1000).toFixed(3)}</b><span>最低单体 V</span></div>
            <div class="kpi"><b>${(s.cell_diff_mv / 1000).toFixed(3)}</b><span>压差 V</span></div>
            <div class="kpi"><b>${s.cycles}</b><span>循环次数</span></div>
          </div>`;
        panels = `
          <div class="panel">
            <div class="phead"><span>单体电压 (mV)</span></div>
            <div class="cells">
              ${s.cells_mv.map((v, i) => `
                <div class="cell ${v >= s.cell_max_mv - 8 ? 'hi' : (v <= s.cell_min_mv + 8 ? 'lo' : '')}">
                  <div class="cwrap"><div class="cbar" style="height:${Math.max(6, Math.round(v / s.cell_max_mv * 100))}%"></div></div>
                  <span>${v}</span><i>#${i + 1}</i>
                </div>`).join('')}
            </div>
          </div>
          <div class="panel">
            <div class="phead"><span>电池参数</span></div>
            <div class="kvbox">
              ${kv('满电', s.full ? '是' : '否')}
              ${kv('充电中', s.charging ? '是' : '否')}
              ${kv('放电中', s.discharging ? '是' : '否')}
              ${kv('均衡中', s.balance ? '是' : '否')}
              ${kv('告警等级', String(s.alarm_level))}
              ${kv('MOS 温度', s.mos_t + '℃')}
              ${kv('剩余容量', (s.remain_mah / 1000).toFixed(2) + 'Ah')}
            </div>
          </div>`;
      }
    }

    view.innerHTML = `
      <div class="detail">
        <div class="dhead">
          <a class="back" href="#/">← 返回列表</a>
          <div class="dtitle"><span class="cicon">${s && s.type === 'bms' ? '🔋' : '☀️'}</span>${esc(m.name || devId)} <span class="cbadge"><i class="dot ${st === 'online' ? 'on' : st === 'offline' ? 'off' : ''}"></i>${st === 'online' ? '在线' : st === 'offline' ? '离线' : '未知'}</span></div>
          <div class="dsub">${esc(m.site || '')} · #${esc(devId)}${m.model ? ' · ' + esc(m.model) : ''}</div>
        </div>
        ${kpis}
        ${panels}
        <div class="panel">
          <div class="phead"><span>设备档案</span></div>
          <div class="kvbox wide">
            ${kv('设备ID', devId)}
            ${kv('IMEI', m.imei)}
            ${kv('型号', m.model)}
            ${kv('固件', m.fw)}
            ${kv('位置', m.site)}
            ${kv('最后上报', s ? fmt.t(s.ts) : '--')}
          </div>
        </div>
        <div class="panel">
          <div class="phead"><span>最近事件</span></div>
          <div class="events">
            ${d.events.length ? d.events.slice(0, 20).map(ev => `
              <div class="ev ${ev.kind || ''}">
                <span class="evt">${fmt.t(ev.ts)}</span>
                <span class="evn">${esc(ev.name)}</span>
                <span class="evd">${esc(ev.data || '')}</span>
              </div>`).join('') : '<div class="small" style="color:var(--muted)">暂无事件</div>'}
          </div>
        </div>
      </div>`;
  }

  function kv(k, v) {
    return `<div class="kv"><span>${esc(k)}</span><b>${v == null || v === '' ? '--' : esc(String(v))}</b><i></i></div>`;
  }

  // ---------- 路由 ----------

  function route() {
    const h = location.hash;
    if (h && h.startsWith('#dev/')) {
      renderDetail(h.slice(5));
    } else {
      renderList();
    }
  }

  // ---------- 登录 ----------

  function showLogin() {
    $('#login').hidden = false;
    $('#app').hidden = true;
    const u = $('#loginUser');
    if (u) { u.value = TP.auth.lastUser(); u.focus(); }
  }

  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
  }

  function shakeLogin() {
    const box = $('.loginbox');
    if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
    const err = $('#loginErr');
    if (err) err.hidden = false;
  }

  // ---------- 设置 ----------

  function openSettings() {
    const f = $('#settings');
    if (!f) return;
    f.hidden = false;
    const q = sel => f.querySelector(sel);
    q('[name=url]').value = CFG.url;
    q('[name=username]').value = CFG.username;
    q('[name=password]').value = CFG.password;
    q('[name=turboSec]').value = CFG.turboSec;
    q('[name=debug]').checked = !!TP.debug;
  }

  function closeSettings() { const f = $('#settings'); if (f) f.hidden = true; }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = el('div', '', ''); t.id = 'toast'; document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- 连接状态 ----------

  function renderConn(c) {
    const n = $('#conn');
    if (!n) return;
    const map = {
      online: ['online', '已连接'],
      connecting: ['connecting', '连接中'],
      retry: ['retry', `重连 #${c.retry || 0}`],
      error: ['error', '连接失败'],
    };
    const [cls, text] = map[c.status] || map.connecting;
    n.className = 'conn ' + cls;
    n.innerHTML = `<i></i><span>${text}</span>`;
  }

  // ---------- 对外 ----------

  TP.ui = {
    renderAll: route,
    route,
    showLogin,
    showApp,
    shakeLogin,
    openSettings,
    closeSettings,
    toast,
    renderConn,
    fmt,
  };

  // 事件委托
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.closest && t.closest('#cfgBtn')) { openSettings(); return; }
    if (t.closest && t.closest('.x[data-act=close]')) { const r = $('#risk'); if (r) r.hidden = true; return; }
    if (t.closest && t.closest('#settings [data-act=cancel]')) { closeSettings(); return; }
    if (t.closest && t.closest('#settings [data-act=reset]')) { TP.cfg.reset(); location.reload(); return; }
    if (t.closest && t.closest('#settings [data-act=cache]')) { try { localStorage.clear(); } catch (e) {} location.reload(); return; }
    if (t.closest && t.closest('#settings [data-act=logout]')) { TP.auth.logout(); location.reload(); return; }
    if (t.closest && t.closest('#settings [data-act=theme]')) {
      const r = document.documentElement;
      const cur = r.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      r.setAttribute('data-theme', next);
      try { localStorage.setItem('tp.theme', next); } catch (e) {}
      return;
    }
  });

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'settings') {
      e.preventDefault();
      const f = e.target;
      const q = sel => f.querySelector(sel);
      TP.cfg.save({
        url: q('[name=url]').value.trim(),
        username: q('[name=username]').value.trim(),
        password: q('[name=password]').value,
        turboSec: Math.min(1800, Math.max(60, parseInt(q('[name=turboSec]').value, 10) || 300)),
      });
      closeSettings();
      location.reload();
    }
  });

  window.addEventListener('hashchange', route);

  // 主题初始化
  try {
    const t = localStorage.getItem('tp.theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}

})(typeof globalThis !== 'undefined' ? globalThis : this);