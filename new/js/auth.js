/**
 * auth.js —— 页面登录门禁
 *
 * 账号密码就写死在这个文件里（改下面的 AUTH 即可），登录后才能看到设备列表。
 * 不登录时不会连接 MQTT、不渲染任何设备数据。
 *
 * ⚠️ 必须清楚这是**界面门禁**，不是安全边界：
 *    源码在浏览器里明文可见，任何人打开 js 就能看到账号密码，也能直接拿
 *    config.js 里的 MQTT 账号去连 broker。
 *    真正能挡住别人的是 EMQX 控制台的 ACL（限制哪个账号能订阅/发布哪些 topic），
 *    这个登录框只是防止"链接被随手转发后被人点开就看到数据"。
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});

  // ============================================================
  // ★ 账号密码：改这里
  // ============================================================
  const AUTH = {
    user: 'test',
    pass: 'test',
    rememberDays: 7,        // 勾「记住我」后的免登录天数
  };

  const KEY = 'tp.auth.v1';        // 登录票据
  const LAST = 'tp.auth.user';     // 上次登录的用户名（只用于回填输入框）

  function now() { return Date.now(); }

  /** 纯校验，便于离线单测 */
  function check(u, p) {
    return String(u == null ? '' : u) === AUTH.user &&
           String(p == null ? '' : p) === AUTH.pass;
  }

  /** 拿到可用的存储；隐私模式下可能抛错 */
  function pick(kind) {
    try {
      return kind === 'local' ? global.localStorage : global.sessionStorage;
    } catch (e) {
      return null;
    }
  }

  function readFrom(kind) {
    const s = pick(kind);
    if (!s) return null;
    try {
      const raw = s.getItem(KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.u !== AUTH.user) { s.removeItem(KEY); return null; }
      // exp = 0 表示"本次会话"，交给 sessionStorage 自己失效
      if (o.exp && o.exp <= now()) { s.removeItem(KEY); return null; }
      return o;
    } catch (e) {
      return null;
    }
  }

  /** 当前是否已登录 */
  function ok() {
    return !!(readFrom('local') || readFrom('session'));
  }

  /** 登录；成功返回 true */
  function login(u, p, remember) {
    if (!check(u, p)) return false;
    const rec = {
      u: AUTH.user,
      ts: now(),
      exp: remember ? now() + AUTH.rememberDays * 86400000 : 0,
    };
    // 两个存储先清干净，避免"上次记住、这次不记住"却还能免登录
    logout();
    const s = pick(remember ? 'local' : 'session');
    try {
      if (s) s.setItem(KEY, JSON.stringify(rec));
      const l = pick('local');
      if (l) l.setItem(LAST, AUTH.user);
    } catch (e) { /* 写不进去也不影响本次会话 */ }
    return true;
  }

  function logout() {
    for (const kind of ['local', 'session']) {
      const s = pick(kind);
      if (!s) continue;
      try { s.removeItem(KEY); } catch (e) { /* ignore */ }
    }
  }

  /** 上次登录的用户名，用于回填 */
  function lastUser() {
    const s = pick('local');
    try { return (s && s.getItem(LAST)) || ''; } catch (e) { return ''; }
  }

  TP.AUTH = AUTH;
  TP.auth = { AUTH, check, ok, login, logout, lastUser };

})(typeof globalThis !== 'undefined' ? globalThis : this);
