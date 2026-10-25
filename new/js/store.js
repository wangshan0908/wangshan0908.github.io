/**
 * store.js —— 设备状态仓库
 *
 * 只做三件事：
 *   1. 把 MQTT 上来的 topic 拆成 {pk, id, kind}，分发到设备对象
 *   2. 维护在线状态（retained status + LWT 为主，数据超时为兜底）
 *   3. 落一份 localStorage 缓存，页面重开时先渲染上次的样子
 *
 * 为什么要有缓存：手机在电梯里打开页面时，如果等 MQTT 连上才渲染，
 * 屏幕会空白十几秒。先显示"上次看到的 + 标注数据时间"，体验差别很大。
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});
  const CACHE_KEY = 'tp.cache.v1';

  const devices = new Map();
  let listeners = [];
  let cacheTimer = null;

  // ---------- 工具 ----------

  function nowMs() { return Date.now(); }

  function newDev(id) {
    return {
      id: id,
      pk: '',
      role: '',          // mppt / bms
      name: '',
      site: '',
      fw: '',
      meta: null,
      metaRx: 0,

      status: null,      // {on, ts, w}
      statusRx: 0,

      d: null,           // 最新解码帧
      rxTs: 0,           // 本地收到时间（ms）
      devTs: 0,          // 设备时间戳（ms，可能不准）
      seq: -1,
      frames: 0,
      lost: 0,           // seq 空洞累计
      bad: 0,            // 坏帧数

      hist: [],          // [{t, ...}] 曲线点
      events: [],        // 事件日志（最多 30 条）
      ack: null,         // 最近一次命令回执
      cmdSent: null,     // 最近一次发出的命令（等回执时显示 pending）
    };
  }

  function dev(id) {
    let d = devices.get(id);
    if (!d) { d = newDev(id); devices.set(id, d); }
    return d;
  }

  // ---------- topic 解析 ----------
  // v1/{pk}/{id}/up/{kind}
  function parseTopic(topic) {
    const p = topic.split('/');
    if (p.length !== 5 || p[0] !== 'v1' || p[3] !== 'up') return null;
    return { pk: p[1], id: p[2], kind: p[4] };
  }

  // ---------- 在线判定 ----------
  function onlineState(d) {
    const age = d.rxTs ? (nowMs() - d.rxTs) / 1000 : Infinity;
    const st = d.status;

    if (st && st.on === 0) {
      // 遗嘱优先：但设备可能刚重连，若之后又来了数据就以数据为准
      if (d.rxTs && d.statusRx && d.rxTs > d.statusRx) return 'online';
      return 'offline';
    }
    if (st && st.on === 1) {
      if (age > TP.CFG.offlineSec) return 'offline';
      return 'online';
    }
    // 没有 status（旧固件/未订阅到 retained）：只靠数据时间
    if (!d.rxTs) return 'unknown';
    return age > TP.CFG.offlineSec ? 'offline' : 'online';
  }

  /**
   * 在线徽章三态：
   *   online   status=1 且数据新鲜
   *   stale    status=1 但超过 warnSec 没数据（夜间静默会命中，属正常）
   *   offline  status=0 或兜底超时
   *   unknown  还没收到任何消息
   */
  function badge(d) {
    const s = onlineState(d);
    if (s !== 'online') return s;
    const age = d.rxTs ? (nowMs() - d.rxTs) / 1000 : Infinity;
    if (age > TP.CFG.warnSec) return 'stale';
    return 'online';
  }

  // ---------- 订阅分发 ----------

  const handlers = {
    meta(d, payload) {
      let m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      d.meta = m;
      d.metaRx = nowMs();
      d.pk = m.pk || d.pk;
      d.role = m.role || m.cls || d.role;
      d.name = m.name || d.name;
      d.site = m.site || d.site;
      d.fw = m.fw || d.fw;
      d.cls = m.cls || d.cls;
      pushEvent(d, { t: 'meta', ts: m.ts });
    },

    status(d, payload) {
      let s;
      try { s = JSON.parse(payload); } catch (e) { s = { on: 0 }; }
      d.status = s;
      d.statusRx = nowMs();
      if (s.on) {
        // 上线事件：只在从"离线"变"在线"时记一条，别每次 retained 覆盖都记
        pushEvent(d, { t: 'online', ts: s.ts });
      } else {
        pushEvent(d, { t: 'offline', ts: s.ts, w: s.w });
      }
    },

    event(d, payload) {
      let e;
      try { e = JSON.parse(payload); } catch (err) { return; }
      if (!e.t) return;

      if (e.t === 'ack') {
        d.ack = { id: e.id, ok: e.ok === 1, r: e.r, m: e.m, ts: nowMs() };
      }
      pushEvent(d, Object.assign({ ts: nowMs() }, e));
    },

    state(d, bytes, info) {
      const frame = TP.codec.decode(bytes);
      if (!frame) { d.bad++; pushEvent(d, { t: 'bad', ts: nowMs() }); return; }

      // seq 空洞 = 丢包（QoS0 正常现象，但连续空洞说明网络在抖）
      if (d.seq >= 0 && frame.seq !== ((d.seq + 1) & 0xffff)) {
        const gap = (frame.seq - d.seq - 1) & 0xffff;
        if (gap > 0 && gap < 100) d.lost += gap;
      }
      d.seq = frame.seq;
      d.frames++;
      d.d = frame;
      d.rxTs = nowMs();
      d.devTs = frame.ts || 0;
      if (!d.role) d.role = frame.type;     // 没收到 meta 时先用帧头兜底

      // 曲线点：按角色存不同指标，键名与详情页的指标切换表对应
      const t = Math.floor(d.rxTs / 1000);
      const last = d.hist[d.hist.length - 1];
      if (!last || t > last.t) {
        const pt = { t: t };
        if (frame.type === 'mppt') {
          pt.pv_w = frame.pv_w;
          pt.pv_v = frame.pv_v;
          pt.pv_a = frame.pv_a;
          pt.bat_v = frame.bat_v;
          pt.bat_a = frame.bat_a;
          pt.load_w = frame.load_w;
          pt.soc = frame.soc;
        } else {
          pt.soc = frame.soc;
          pt.pack_v = frame.pack_v;
          pt.pack_a = frame.pack_a;
          pt.diff = frame.cell_diff_mv;
        }
        d.hist.push(pt);
        if (d.hist.length > TP.CFG.keepPoints) d.hist.splice(0, d.hist.length - TP.CFG.keepPoints);
      }
    },
  };

  function pushEvent(d, e) {
    d.events.push(e);
    if (d.events.length > 30) d.events.splice(0, d.events.length - 30);
  }

  /** MQTT 消息入口 */
  function onMessage(topic, payload, meta) {
    const p = parseTopic(topic);
    if (!p) return false;

    const d = dev(p.id);
    if (!d.pk) d.pk = p.pk;

    const kind = p.kind;
    if (kind === 'state') {
      // 二进制直接用 Uint8Array，不经过字符串（UTF-8 解码会毁掉 0x80 以上的字节）
      handlers.state(d, payload, meta);
    } else {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
      if (handlers[kind]) handlers[kind](d, text);
      else return false;
    }

    scheduleCache();
    notify();
    return true;
  }

  // ---------- 变更通知 ----------
  function onChange(fn) { listeners.push(fn); }

  let notifyTimer = null;
  function notify() {
    // 合并同一轮的多条消息，避免 4 个包触发 4 次重绘
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const fn of listeners) {
        try { fn(); } catch (e) { console.error('[store] 监听异常', e); }
      }
    }, 120);
  }

  /** 定时器调用：只为了刷新"多久以前"和在线兜底，不重绘全表 */
  function tick() {
    notify();
    scheduleCache();
  }

  // ---------- 缓存 ----------

  function scheduleCache() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      saveCache();
    }, 3000);
  }

  function saveCache() {
    try {
      const out = {};
      for (const [id, d] of devices) {
        out[id] = {
          id: d.id, pk: d.pk, role: d.role, name: d.name, site: d.site, fw: d.fw,
          meta: d.meta, status: d.status, statusRx: d.statusRx,
          d: d.d, rxTs: d.rxTs, devTs: d.devTs, seq: d.seq, frames: d.frames,
          hist: d.hist.slice(-60),
          events: d.events.slice(-10),
        };
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (e) {
      // 满仓或隐私模式：清掉缓存别拖垮页面
      try { localStorage.removeItem(CACHE_KEY); } catch (e2) { /* ignore */ }
    }
  }

  function loadCache() {
    let raw;
    try { raw = localStorage.getItem(CACHE_KEY); } catch (e) { return 0; }
    if (!raw) return 0;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return 0; }
    let n = 0;
    for (const id of Object.keys(o)) {
      const c = o[id];
      const d = dev(id);
      Object.assign(d, c);
      // rxTs 是绝对毫秒时间戳，重开页面后 age 仍然算得对（这正是要的效果）
      d.hist = c.hist || [];
      d.events = c.events || [];
      n++;
    }
    return n;
  }

  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- 查询 ----------

  function list() {
    const arr = Array.from(devices.values());
    // 排序：在线在前，然后 MPPT 在 BMS 前，然后按名字
    const rank = { online: 0, stale: 1, unknown: 2, offline: 3 };
    arr.sort((a, b) => {
      const ra = rank[badge(a)], rb = rank[badge(b)];
      if (ra !== rb) return ra - rb;
      if ((a.role === 'bms') !== (b.role === 'bms')) return a.role === 'bms' ? 1 : -1;
      return (a.name || a.id).localeCompare(b.name || b.id, 'zh');
    });
    return arr;
  }

  function summary() {
    let on = 0, total = devices.size, mppt = 0, bms = 0;
    let wh = 0;
    for (const d of devices.values()) {
      if (badge(d) === 'online' || badge(d) === 'stale') on++;
      if (d.role === 'bms') bms++; else if (d.role === 'mppt') mppt++;
      if (d.d && d.role === 'mppt') wh += (d.d.wh_today || 0);
    }
    return { on, total, mppt, bms, whToday: wh };
  }

  function get(id) { return devices.get(id) || null; }

  function forget(id) { devices.delete(id); scheduleCache(); notify(); }

  TP.store = {
    onMessage, onChange, tick, list, summary, get, badge, onlineState,
    loadCache, clearCache, forget, devices,
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
