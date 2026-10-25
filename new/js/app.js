/**
 * app.js —— 应用入口：串起 auth / mqtt / store / ui
 *
 * 加载顺序（index.html）：config → auth → mqtt → codec → store → ui → app
 */
(function (global) {
  'use strict';

  const TP = global.TP;

  const $ = TP.$;
  const auth = TP.auth;
  const cfg = TP.cfg;
  const store = TP.store;
  const ui = TP.ui;

  function init() {
    // 先决定显示登录框还是主界面
    if (!auth.ok()) {
      ui.showLogin();
      return;
    }
    start();
  }

  function start() {
    ui.showApp();
    store.init();
    ui.renderAll();
    TP.mqtt.connect();
  }

  // 登录成功
  $(global.document).on('submit', '#loginForm', function (e) {
    e.preventDefault();
    const user = $('#loginUser').value.trim();
    const pass = $('#loginPass').value;
    const remember = $('#loginRemember').checked;
    if (!auth.login(user, pass, remember)) {
      ui.shakeLogin();
      return;
    }
    start();
  });

  // 退出
  $(global.document).on('click', '#logoutBtn', function () {
    auth.logout();
    location.reload();
  });

  init();

})(typeof globalThis !== 'undefined' ? globalThis : this);