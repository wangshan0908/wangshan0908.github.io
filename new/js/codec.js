/**
 * codec.js —— 浏览器全局版（由 tools/sync_web.py 从 web/codec.js 生成，勿手改）
 *
 * 源文件改动后跑：python tools/sync_web.py
 * 挂载点：window.TP.codec
 */
(function (global) {
  'use strict';
  const TP = global.TP || (global.TP = {});
  /**
   * tp_codec.js —— 遥测帧二进制解码（前端）
   * 与 code/common/tp_codec.lua 严格对应，字段名一致
   *
   * 数据来源：MQTT 短主题 t/{sid} 的 payload（ArrayBuffer / Uint8Array）
   *
   *   const d = decode(buf);
   *   if (d) render(d);   // 返回 null 表示坏帧，直接丢弃并计数
   */

  const VER = 1;
  const HDR_MPPT = 0xa1;
  const HDR_BMS = 0xb1;
  const LEN_MPPT = 32;
  const LEN_BMS = 42;

  const CHG = ['idle', 'charging', 'full', 'fault'];

  function toView(buf) {
    if (buf instanceof DataView) return buf;
    if (buf instanceof ArrayBuffer) return new DataView(buf);
    if (ArrayBuffer.isView(buf)) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return null;
  }

  /** 按帧头自动分发 */
  function decode(buf) {
    const v = toView(buf);
    if (!v || v.byteLength < 2) return null;
    const hdr = v.getUint8(0);
    if (hdr === HDR_MPPT) return decodeMppt(v);
    if (hdr === HDR_BMS) return decodeBms(v);
    return null;
  }

  function decodeMppt(input) {
    const v = toView(input);
    if (!v || v.byteLength !== LEN_MPPT) return null;
    if (v.getUint8(0) !== HDR_MPPT || v.getUint8(1) !== VER) return null;

    const f = v.getUint8(21);
    const pvV = v.getUint16(8) / 100;
    const pvA = v.getUint16(10) / 100;
    const batV = v.getUint16(12) / 100;
    const loadA = v.getUint16(16) / 100;
    return {
      type: 'mppt',
      seq: v.getUint16(2),
      ts: v.getUint32(4) * 1000,
      pv_v: pvV,
      pv_a: pvA,
      bat_v: batV,
      bat_a: v.getInt16(14) / 100,
      load_a: loadA,
      bat_t: v.getInt8(18),
      buck_t: v.getInt8(19),
      soc: v.getUint8(20),
      flags: f,
      load_on: (f & 0x01) !== 0,
      chg: CHG[(f >> 1) & 0x03],
      chg_code: (f >> 1) & 0x03,
      fan: (f & 0x08) !== 0,
      night: (f & 0x10) !== 0,
      comm_err: (f & 0x20) !== 0,
      fault: (f & 0x40) !== 0,
      wh_today: v.getUint16(22) / 100,
      wh_total: v.getUint32(24) / 10,
      pv_max_w: v.getUint16(28),
      csq: v.getUint8(30),
      // 派生字段（页面直接用，省得每处再算）
      pv_w: pvV * pvA,
      load_w: batV * loadA,
    };
  }

  function decodeBms(input) {
    const v = toView(input);
    if (!v || v.byteLength !== LEN_BMS) return null;
    if (v.getUint8(0) !== HDR_BMS || v.getUint8(1) !== VER) return null;

    const f = v.getUint8(17);
    const n = v.getUint8(16);
    const cnt = n > 0 && n <= 8 ? n : 8;
    const cells = [];
    for (let i = 0; i < cnt; i++) cells.push(v.getUint16(18 + i * 2));

    const vmax = Math.max(...cells);
    const vmin = Math.min(...cells);

    return {
      type: 'bms',
      seq: v.getUint16(2),
      ts: v.getUint32(4) * 1000,
      pack_v: v.getUint16(8) / 1000,
      pack_a: v.getInt16(10) / 10,
      soc: v.getUint8(12),
      soh: v.getUint8(13),
      remain_mah: v.getUint16(14) * 10,
      cell_num: n,
      flags: f,
      full: (f & 0x01) !== 0,
      allow_dis: (f & 0x02) !== 0,
      genuine: (f & 0x04) !== 0,
      balance: (f & 0x08) !== 0,
      charging: (f & 0x10) !== 0,
      discharging: (f & 0x20) !== 0,
      alarm_level: (f >> 6) & 0x03,
      cells_mv: cells,
      cell_max_mv: vmax,
      cell_min_mv: vmin,
      cell_diff_mv: vmax - vmin,
      mos_t: v.getInt8(34),
      t1: v.getInt8(35),
      t2: v.getInt8(36),
      t3: v.getInt8(37),
      cycles: v.getUint16(38),
      alarm: v.getUint8(40),
    };
  }

  /** 十六进制字符串 → ArrayBuffer（从日志/抓包里手工回放用） */
  function fromHex(hex) {
    const h = hex.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out.buffer;
  }

  TP.codec = {
    VER, HDR_MPPT, HDR_BMS, LEN_MPPT, LEN_BMS,
    decode, decodeMppt, decodeBms, fromHex,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);