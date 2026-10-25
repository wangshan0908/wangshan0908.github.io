/**
 * config.js —— 页面配置（集中一处，改这里不用翻业务代码）
 *
 * 连接参数会存到 localStorage，页面上也能改（右上角齿轮）。
 * ⚠️ 默认账号是 test/test，写在公开仓库里，任何人都能订到你的数据。
 *    上线前请在 EMQX 控制台建独立账号，然后在这个页面上改掉。
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});

  const DEFAULTS = {
    // EMQX Serverless 的 WebSocket 入口：端口 8084，路径 /mqtt
    url: 'wss://y1151fa9.ala.cn-hangzhou.emqxsl.cn:8084/mqtt',
    username: 'test',
    password: 'test',
    keepalive: 60,

    // 一条通配符覆盖所有设备的所有上行主题
    //   v1/{pk}/{devId}/up/{state|event|meta|status}
    subTopic: 'v1/+/+/up/#',

    // 下行命令主题模板（{pk} {id} 会被替换）
    cmdTopic: 'v1/{pk}/{id}/down/cmd',

    // 打开详情页自动请求 3s 快报，秒数
    turboSec: 300,

    // 数据新鲜度：超过这么多秒没收到帧，数字变灰并标注
    warnSec: 1800,
    // 在线兜底：status 说在线但这么久没有任何数据，判定为离线
    // （LWT 是主判据，这个只兜 broker 没发遗嘱的极端情况）
    offlineSec: 5400,

    // 内存里保留的历史点数（详情页画曲线用，不落盘）
    keepPoints: 240,
  };

  const KEY = 'tp.cfg.v1';

  const CFG = Object.assign({}, DEFAULTS);

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
          if (o[k] !== undefined && o[k] !== null) CFG[k] = o[k];
        }
      }
    } catch (e) { /* 存储坏了就用默认值 */ }
    return CFG;
  }

  function save(patch) {
    Object.assign(CFG, patch || {});
    try {
      const o = {};
      for (const k of Object.keys(DEFAULTS)) o[k] = CFG[k];
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* 隐私模式写不进去，忽略 */ }
    return CFG;
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    Object.assign(CFG, DEFAULTS);
    return CFG;
  }

  TP.CFG = CFG;
  TP.cfg = { DEFAULTS, load, save, reset };

})(typeof globalThis !== 'undefined' ? globalThis : this);