/**
 * store.js —— 前端内存仓库 + localStorage 持久化
 *
 * 结构：
 *   devices: { [devId]: { meta, status, lastState, states:[...], events:[...], turbo } }
 */
(function (global) {
  'use strict';

  const TP = global.TP;
  const CFG = TP.CFG;

  const store = {
    devices: {},
    order: [],       // 按首次出现顺序
    onDevice: null,  // (devId) 回调：设备数据变化时通知 UI

    init() {},

    // ---------- meta / status ----------
    upsertMeta(devId, meta) {
      let d = this.devices[devId];
      if (!d) { d = this.devices[devId] = { meta: null, status: null, states: [], events: [] }; this.order.push(devId); }
      d.meta = Object.assign({}, d.meta, meta);
      if (this.onDevice) this.onDevice(devId);
      return d;
    },

    upsertStatus(devId, status) {
      let d = this.devices[devId];
      if (!d) { d = this.devices[devId] = { meta: null, status: null, states: [], events: [] }; this.order.push(devId); }
      d.status = Object.assign({}, d.status, status);
      if (this.onDevice) this.onDevice(devId);
      return d;
    },

    // ---------- 遥测状态 ----------
    pushState(devId, st) {
      let d = this.devices[devId];
      if (!d) { d = this.devices[devId] = { meta: null, status: null, states: [], events: [] }; this.order.push(devId); }
      d.lastState = st;
      d.states.push(st);
      if (d.states.length > CFG.keepPoints) d.states.shift();
      if (this.onDevice) this.onDevice(devId);
      return d;
    },

    pushEvent(devId, ev) {
      let d = this.devices[devId];
      if (!d) { d = this.devices[devId] = { meta: null, status: null, states: [], events: [] }; this.order.push(devId); }
      d.events.unshift(ev);
      if (d.events.length > 50) d.events.pop();
      if (this.onDevice) this.onDevice(devId);
      return d;
    },

    device(devId) { return this.devices[devId] || null; },

    list() { return this.order.map(id => ({ id, d: this.devices[id] })); },

    clear() { this.devices = {}; this.order = []; },
  };

  TP.store = store;

})(typeof globalThis !== 'undefined' ? globalThis : this);