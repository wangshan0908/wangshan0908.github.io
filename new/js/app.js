/**
 * app.js —— 入口：连接、订阅、命令、设置面板
 *
 * 页面只有一个连接、一条订阅（v1/+/+/up/#），设备增减都不用改代码。
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});
  const S = TP.store;
  const CFG = TP.CFG;

  let mqtt = null;
  let connState = 'init';       // init / connecting / online / retry / error
  let retryInfo = null;
  let lastTurbo = {};           // devId -> 上次请求快报的时间
  let DEBUG = false;

  try { DEBUG = sessionStorage.getItem('tp.debug') === '1'; } catch (e) { DEBUG = false; }

  // ============================================================
  // 连接状态显示
  // ============================================================

  function setConn(state, text) {
    connState = state;
    const el = document.getElementById('conn');
    if (!el) return;
    el.className = 'conn ' + state;
    const t = el.querySelector('span');
    if (t) t.textContent = text;
  }

  function newClientId() {
    // EMQX Serverless 限 23 字符；用时间戳 + 随机，避免多标签页互相踢下线
    const r = Math.random().toString(36).slice(2, 6);
    return ('web' + Date.now().toString(36) + r).slice(0, 23);
  }

  function connect() {
    if (mqtt) { try { mqtt.end(); } catch (e) { /* ignore */ } }

    setConn('connecting', '连接中…');
    mqtt = new TP.Mqtt({
      url: CFG.url,
      clientId: newClientId(),
      username: CFG.username,
      password: CFG.password,
      keepalive: CFG.keepalive,
    });

    mqtt.on('connect', async () => {
      setConn('online', '已连接');
      const ok = await mqtt.subscribe(CFG.subTopic, 0);
      if (!ok) {
        setConn('error', '订阅失败');
        TP.ui.toast('订阅被拒绝：检查账号权限');
        return;
      }
      addLog('info', `已订阅 ${CFG.subTopic}`);
      // 连上后主动问一次：让设备立刻补档案 + 发一帧（覆盖"retained 被清掉"的情况）
      for (const d of S.devices.values()) {
        if (S.badge(d) === 'offline') continue;
        sendCmd(d, 'hello', {}).catch(() => {});
      }
    });

    mqtt.on('message', (topic, payload) => {
      S.onMessage(topic, payload);
    });

    mqtt.on('reconnect', (info) => {
      retryInfo = info;
      setConn('retry', `重连中 ${Math.round(info.delay / 1000)}s`);
    });

    mqtt.on('error', (err) => {
      addLog('error', err.message || String(err));
      if (!mqtt.connected) setConn('error', err.message ? '连接失败' : '连接异常');
    });

    mqtt.on('close', () => {
      if (!mqtt.ended) setConn('retry', '连接断开');
    });

    mqtt.connect();

    if (typeof TP.sendCmd !== 'function') {
      TP.sendCmd = sendCmd;
    }
  }

  // ============================================================
  // 命令
  // ============================================================

  function sendCmd(d, op, extra) {
    if (!mqtt || !mqtt.connected) return Promise.resolve(false);

    const topic = CFG.cmdTopic
      .replace('{pk}', d.pk || 'x')
      .replace('{id}', d.id);
    const id = TP.mqttMsgId();
    const body = Object.assign({ id: id, op: op }, extra || {});

    d.cmdSent = { id, op, ts: Date.now() };
    addLog('out', `${op} → ${d.name || d.id}`);

    return mqtt.publish(topic, JSON.stringify(body), 1, false).then((ok) => {
      if (!ok) addLog('error', `${op} 发送失败`);
      return ok;
    });
  }

  // ============================================================
  // 设置面板
  // ============================================================

  function openSettings() {
    const ov = document.getElementById('settings');
    if (!ov) return;
    ov.hidden = false;
    const f = ov.querySelector('form');
    f.url.value = CFG.url;
    f.username.value = CFG.username;
    f.password.value = CFG.password;
    f.turboSec.value = CFG.turboSec;
    f.debug.checked = DEBUG;
  }

  function closeSettings() {
    const ov = document.getElementById('settings');
    if (ov) ov.hidden = true;
  }

  function bindSettings() {
    const ov = document.getElementById('settings');
    if (!ov) return;

    ov.querySelector('[data-act="cancel"]').addEventListener('click', closeSettings);

    ov.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const patch = {
        url: f.url.value.trim(),
        username: f.username.value.trim(),
        password: f.password.value,
        turboSec: Math.max(60, Math.min(1800, Number(f.turboSec.value) || 300)),
      };
      if (!/^wss?:\/\//.test(patch.url)) {
        TP.ui.toast('地址要以 ws:// 或 wss:// 开头');
        return;
      }
      TP.cfg.save(patch);
      applyDebug(f.debug.checked);
      closeSettings();
      addLog('info', '配置已保存，重新连接');
      connect();
    });

    ov.querySelector('[data-act="theme"]').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : (cur === 'light' ? '' : 'dark');
      if (next) document.documentElement.setAttribute('data-theme', next);
      else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('tp.theme', next || 'auto'); } catch (e) { /* ignore */ }
      TP.ui.render();
      TP.ui.toast(next === 'dark' ? '深色' : (next === 'light' ? '浅色' : '跟随系统'));
    });

    ov.querySelector('[data-act="reset"]').addEventListener('click', () => {
      if (!confirm('恢复默认配置？会丢掉账号密码和地址。')) return;
      TP.cfg.reset();
      closeSettings();
      connect();
    });

    ov.querySelector('[data-act="cache"]').addEventListener('click', () => {
      if (!confirm('清掉本地缓存的设备清单和最后一帧？')) return;
      S.clearCache();
      location.reload();
    });

    const lo = ov.querySelector('[data-act="logout"]');
    if (lo) {
      lo.addEventListener('click', () => {
        if (confirm('退出登录？下次打开需要重新输入账号密码。')) logout();
      });
    }
  }

  // ============================================================
  // 日志（顶部小条，只在调试时显示）
  // ============================================================

  const logs = [];
  function addLog(level, msg) {
    logs.push({ t: Date.now(), level, msg });
    if (logs.length > 100) logs.shift();
    if (!DEBUG) return;
    const box = document.getElementById('debug');
    if (!box) return;
    box.hidden = false;
    box.textContent = logs.slice(-12).map(l =>
      new Date(l.t).toTimeString().slice(0, 8) + ' [' + l.level + '] ' + l.msg).join('\n');
    box.scrollTop = box.scrollHeight;
  }

  function applyDebug(on) {
    DEBUG = on;
    const box = document.getElementById('debug');
    if (box) {
      box.hidden = !on;
      if (on) addLog('info', '调试日志已开启');
      else box.textContent = '';
    }
    try { sessionStorage.setItem('tp.debug', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // ============================================================
  // 登录门禁
  // 未登录：只显示登录框，不连 MQTT、不渲染设备（连数据都不订阅）
  // ============================================================

  function showLogin() {
    const box = document.getElementById('login');
    const app = document.getElementById('app');
    if (app) app.hidden = true;
    if (!box) return;
    box.hidden = false;

    const f = document.getElementById('loginForm');
    const err = document.getElementById('loginErr');
    const btn = document.getElementById('loginBtn');
    const u = document.getElementById('loginUser');
    const p = document.getElementById('loginPass');
    if (!f || !u || !p) return;

    u.value = TP.auth.lastUser() || '';
    (u.value ? p : u).focus();

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (btn && btn.disabled) return;

      const passed = TP.auth.login(u.value.trim(), p.value,
        !!(f.remember && f.remember.checked));

      if (!passed) {
        if (err) err.hidden = false;
        f.classList.remove('shake');
        void f.offsetWidth;             // 强制重排，让动画能重复触发
        f.classList.add('shake');
        p.value = '';
        p.focus();
        return;
      }

      if (err) err.hidden = true;
      p.value = '';                     // 别把密码留在 DOM 里
      box.hidden = true;
      startApp();
    });
  }

  /** 退出登录：清票据 → 断开连接 → 整页重载（内存里的设备数据一并清掉） */
  function logout() {
    TP.auth.logout();
    try { if (mqtt) mqtt.end(); } catch (e) { /* ignore */ }
    mqtt = null;
    location.reload();
  }

  // ============================================================
  // 启动
  // ============================================================

  function boot() {
    TP.cfg.load();

    // 主题：auto 表示不设 data-theme，交给 prefers-color-scheme
    try {
      const th = localStorage.getItem('tp.theme');
      if (th && th !== 'auto') document.documentElement.setAttribute('data-theme', th);
    } catch (e) { /* ignore */ }

    if (DEBUG) applyDebug(true);

    // 门禁：没登录就先停在登录框，别急着连 broker
    if (!TP.auth.ok()) {
      showLogin();
      return;
    }
    startApp();
  }

  /** 登录之后才走这里：渲染、绑定、连 MQTT */
  function startApp() {
    const app = document.getElementById('app');
    if (app) app.hidden = false;
    const box = document.getElementById('login');
    if (box) box.hidden = true;

    // 先渲染缓存：手机上弱网时，空白十几秒的体验很差
    const n = S.loadCache();
    TP.ui.mount(document.getElementById('view'));
    TP.ui.render();
    if (n) addLog('info', `已从缓存恢复 ${n} 台设备`);

    bindSettings();
    document.getElementById('cfgBtn').addEventListener('click', openSettings);

    const outBtn = document.getElementById('logoutBtn');
    if (outBtn) {
      outBtn.addEventListener('click', () => {
        if (confirm('退出登录？')) logout();
      });
    }

    // 风险提示条：test/test 写在公开仓库里，这条不该被忽略
    const risk = document.getElementById('risk');
    if (risk) {
      if (sessionStorage.getItem('risk.closed') === '1') risk.hidden = true;
      else {
        risk.hidden = false;
        risk.querySelector('[data-act="close"]').addEventListener('click', () => {
          risk.hidden = true;
          sessionStorage.setItem('risk.closed', '1');
        });
      }
    }

    S.onChange(() => {
      TP.ui.render();
      maybeTurbo();
    });

    // 5 秒刷一次"多久以前"和在线兜底；不跟数据更新抢重绘
    setInterval(() => { S.tick(); }, 5000);

    // 手机切回前台时，定时器可能被冻结，这里主动确认一下连接
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!mqtt || !mqtt.connected) {
        addLog('info', '回到前台，检查连接');
        connect();
      }
    });

    connect();

    if (!n) {
      // 没有缓存也别干等，给个明确提示
      setTimeout(() => {
        if (!S.devices.size) addLog('info', '还没有设备，检查设备是否已连上同一个 broker');
      }, 6000);
    }
  }

  /** 详情页自动请求快报：同一个设备 60s 内只请求一次，避免来回点刷流量 */
  function maybeTurbo() {
    const m = (location.hash || '').match(/^#\/d\/(.+)$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    const d = S.get(id);
    if (!d) return;
    if (S.badge(d) === 'offline') return;

    const last = lastTurbo[id] || 0;
    if (Date.now() - last < 60000) return;
    lastTurbo[id] = Date.now();
    sendCmd(d, 'turbo', { sec: CFG.turboSec }).then((ok) => {
      if (ok) addLog('out', `已请求 ${d.name || id} 快报 ${CFG.turboSec}s`);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  TP.app = { connect, sendCmd, addLog, logout };

})(typeof globalThis !== 'undefined' ? globalThis : this);
