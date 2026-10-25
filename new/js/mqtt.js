/**
 * mqtt.js —— 浏览器端 MQTT 3.1.1 over WebSocket（无第三方依赖）
 *
 * 为什么不引 mqtt.js CDN：
 *   1. GitHub Pages 访问 cdnjs 在国内不稳，页面白屏比连不上更难查
 *   2. 我们只需要 CONNECT / SUBSCRIBE / PUBLISH(QoS0/1) / PING / DISCONNECT
 *      五类报文，引 200KB 库不划算
 *   3. 自己写才能控制重连退避和"假在线"判定
 *
 * 用法：
 *   const c = new TP.Mqtt({ url, clientId, username, password, keepalive });
 *   c.on('connect', () => c.subscribe('v1/+/+/up/#', 0));
 *   c.on('message', (topic, payload) => { ... });   // payload: Uint8Array
 *   c.connect();
 *
 * 注意：EMQX Serverless 的 WSS 端口是 8084、路径 /mqtt；clientId ≤ 23 字符。
 */
(function (global) {
  'use strict';

  const TP = global.TP || (global.TP = {});
  const TEXT = new TextEncoder();
  const DEC = new TextDecoder('utf-8', { fatal: false });

  // ---------- 编码工具 ----------

  function utf8(s) { return TEXT.encode(s == null ? '' : String(s)); }

  /** 剩余长度：7 位一组的变长整数，最多 4 字节 */
  function encLen(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }

  /** 带 2 字节长度前缀的 UTF-8 字符串 */
  function str(s) {
    const b = utf8(s);
    return u16(b.length).concat(Array.from(b));
  }

  function pack(header, body) {
    const len = encLen(body.length);
    const out = new Uint8Array(1 + len.length + body.length);
    out[0] = header;
    for (let i = 0; i < len.length; i++) out[1 + i] = len[i];
    for (let i = 0; i < body.length; i++) out[1 + len.length + i] = body[i];
    return out;
  }

  function bytesToString(b) { return DEC.decode(b); }

  /** 生成短 id（用于命令去重，设备侧按 id 判重） */
  function msgId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---------- 客户端 ----------

  class Mqtt {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url;
      this.clientId = opts.clientId || ('web' + Math.random().toString(36).slice(2, 8));
      this.username = opts.username || '';
      this.password = opts.password || '';
      this.keepalive = opts.keepalive || 60;
      this.clean = opts.clean !== false;

      this.ws = null;
      this.connected = false;
      this.ended = false;

      this._buf = new Uint8Array(0);
      this._pid = 0;
      this._pubAck = new Map();      // packetId -> {resolve, timer}
      this._subWait = new Map();     // packetId -> {resolve, timer}
      this._h = { connect: [], message: [], error: [], close: [], reconnect: [], status: [] };

      this._retry = 0;
      this._lastRx = 0;
      this._pingTimer = null;
      this._reconnTimer = null;
    }

    // ----- 事件 -----
    on(evt, fn) {
      (this._h[evt] || (this._h[evt] = [])).push(fn);
      return this;
    }

    _emit(evt, a, b) {
      const list = this._h[evt];
      if (!list) return;
      for (const fn of list) {
        try { fn(a, b); } catch (e) { console.error('[mqtt] 回调异常', e); }
      }
    }

    // ----- 连接 -----
    connect() {
      this.ended = false;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

      let ws;
      try {
        // 子协议必须写 'mqtt'，EMQX 靠它判断走 MQTT 而不是裸 WS
        ws = new WebSocket(this.url, 'mqtt');
      } catch (e) {
        this._emit('error', e);
        this._scheduleReconnect();
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        this._retry = 0;
        this._buf = new Uint8Array(0);
        this._sendConnect();
      };

      ws.onmessage = (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) this._feed(new Uint8Array(data));
        else if (data && data.buffer) this._feed(new Uint8Array(data.buffer));
        else this._feed(utf8(data));   // 极少数代理会退化成文本帧
      };

      ws.onerror = () => {
        // 浏览器不给 error 详情，统一按断开处理（onclose 随后会来）
        this._emit('error', new Error('WebSocket 错误'));
      };

      ws.onclose = (ev) => {
        this.connected = false;
        this._stopPing();
        this._failPending();
        this._emit('close', { code: ev && ev.code, reason: ev && ev.reason });
        if (!this.ended) this._scheduleReconnect();
      };
    }

    _sendConnect() {
      const flags =
        (this.clean ? 0x02 : 0) |
        (this.username ? 0x80 : 0) |
        (this.password ? 0x40 : 0);

      let body = str('MQTT');
      body.push(4);                    // 协议级别 4 = MQTT 3.1.1
      body.push(flags);
      body = body.concat(u16(this.keepalive));
      body = body.concat(str(this.clientId));
      if (this.username) body = body.concat(str(this.username));
      if (this.password) body = body.concat(str(this.password));

      this._raw(pack(0x10, body));
    }

    /** 直接写原始字节（内部用） */
    _raw(u8) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(u8);
      return true;
    }

    // ----- 订阅 -----
    subscribe(topic, qos) {
      return new Promise((resolve) => {
        const pid = this._nextPid();
        const body = u16(pid).concat(str(topic));
        body.push(qos || 0);
        const timer = setTimeout(() => {
          this._subWait.delete(pid);
          resolve(false);
        }, 5000);
        this._subWait.set(pid, { resolve, timer });
        if (!this._raw(pack(0x82, body))) {
          clearTimeout(timer);
          this._subWait.delete(pid);
          resolve(false);
        }
      });
    }

    // ----- 发布 -----
    /**
     * @param {string} topic
     * @param {Uint8Array|string} payload
     * @param {number} qos 0 或 1
     * @param {boolean} retain
     * @returns {Promise<boolean>} QoS1 等到 PUBACK 才 resolve
     */
    publish(topic, payload, qos, retain) {
      const body = str(topic);
      let pid = 0;
      if (qos === 1) {
        pid = this._nextPid();
        body.push((pid >> 8) & 0xff, pid & 0xff);
      }
      const data = (payload instanceof Uint8Array) ? payload : utf8(payload);
      for (let i = 0; i < data.length; i++) body.push(data[i]);

      const header = 0x30 | ((qos & 0x03) << 1) | (retain ? 0x01 : 0);
      const pkt = pack(header, body);

      if (qos !== 1) {
        return Promise.resolve(this._raw(pkt));
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._pubAck.delete(pid);
          resolve(false);
        }, 6000);
        this._pubAck.set(pid, { resolve, timer });
        if (!this._raw(pkt)) {
          clearTimeout(timer);
          this._pubAck.delete(pid);
          resolve(false);
        }
      });
    }

    _nextPid() {
      this._pid = (this._pid % 65535) + 1;
      return this._pid;
    }

    // ----- 收包 -----
    _feed(chunk) {
      this._lastRx = Date.now();

      // 拼包：一个 WS 帧可能含多个 MQTT 包，也可能只是半包
      const merged = new Uint8Array(this._buf.length + chunk.length);
      merged.set(this._buf, 0);
      merged.set(chunk, this._buf.length);
      this._buf = merged;

      while (this._buf.length >= 2) {
        // 解剩余长度
        let mult = 1, len = 0, i = 1, complete = false;
        while (i < this._buf.length && i <= 4) {
          const b = this._buf[i];
          len += (b & 0x7f) * mult;
          mult *= 128;
          i++;
          if ((b & 0x80) === 0) { complete = true; break; }
        }
        if (!complete) return;             // 长度字段还没收全
        const total = i + len;
        if (this._buf.length < total) return;

        const pkt = this._buf.slice(0, total);
        this._buf = this._buf.slice(total);
        try { this._handle(pkt, i, len); } catch (e) { console.error('[mqtt] 解析失败', e); }
      }
    }

    _handle(pkt, hlen, len) {
      const type = pkt[0] >> 4;

      if (type === 2) {                      // CONNACK
        const rc = pkt.length > hlen + 1 ? pkt[hlen + 1] : 255;
        if (rc === 0) {
          this.connected = true;
          this._startPing();
          this._emit('connect', { clientId: this.clientId });
        } else {
          this.ended = true;                 // 认证被拒就别无限重连
          this._emit('error', new Error('CONNACK 拒绝，返回码 ' + rc +
            (rc === 4 || rc === 5 ? '（用户名或密码错误）' : '')));
          try { this.ws.close(); } catch (e) { /* ignore */ }
        }
        return;
      }

      if (type === 3) {                      // PUBLISH
        const qos = (pkt[0] >> 1) & 0x03;
        const retain = (pkt[0] & 0x01) !== 0;
        let p = hlen;
        const tlen = (pkt[p] << 8) | pkt[p + 1];
        p += 2;
        const topic = bytesToString(pkt.subarray(p, p + tlen));
        p += tlen;

        let pid = 0;
        if (qos > 0) {
          pid = (pkt[p] << 8) | pkt[p + 1];
          p += 2;
        }
        const payload = pkt.subarray(p);

        if (qos === 1 && pid) {
          this._raw(new Uint8Array([0x40, 0x02, (pid >> 8) & 0xff, pid & 0xff]));
        }
        this._emit('message', topic, payload, { qos, retain });
        return;
      }

      if (type === 9) {                      // SUBACK
        const pid = (pkt[hlen] << 8) | pkt[hlen + 1];
        const w = this._subWait.get(pid);
        if (w) {
          clearTimeout(w.timer);
          this._subWait.delete(pid);
          w.resolve(pkt[hlen + 2] !== 0x80);
        }
        return;
      }

      if (type === 4) {                      // PUBACK
        const pid = (pkt[hlen] << 8) | pkt[hlen + 1];
        const w = this._pubAck.get(pid);
        if (w) {
          clearTimeout(w.timer);
          this._pubAck.delete(pid);
          w.resolve(true);
        }
        return;
      }

      if (type === 13) return;               // PINGRESP，_lastRx 已更新
      // 其它类型忽略（本页面不发 QoS2）
    }

    // ----- 心跳 -----
    _startPing() {
      this._stopPing();
      this._lastRx = Date.now();
      const ms = Math.max(15, Math.floor(this.keepalive * 0.6)) * 1000;
      this._pingTimer = setInterval(() => {
        // 服务端静默超过 1.5 个 keepalive，说明这条连接已经死了（NAT 超时等）
        if (Date.now() - this._lastRx > this.keepalive * 1500) {
          this._emit('error', new Error('心跳超时，判定断线'));
          try { this.ws.close(); } catch (e) { /* ignore */ }
          return;
        }
        this._raw(new Uint8Array([0xc0, 0x00]));
      }, ms);
    }

    _stopPing() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    _failPending() {
      for (const [, w] of this._pubAck) { clearTimeout(w.timer); w.resolve(false); }
      for (const [, w] of this._subWait) { clearTimeout(w.timer); w.resolve(false); }
      this._pubAck.clear();
      this._subWait.clear();
    }

    // ----- 重连（指数退避，上限 30s） -----
    _scheduleReconnect() {
      if (this.ended) return;
      if (this._reconnTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, this._retry));
      this._retry = Math.min(this._retry + 1, 5);
      this._emit('reconnect', { delay, attempt: this._retry });
      this._reconnTimer = setTimeout(() => {
        this._reconnTimer = null;
        this.connect();
      }, delay);
    }

    end() {
      this.ended = true;
      this._stopPing();
      if (this._reconnTimer) { clearTimeout(this._reconnTimer); this._reconnTimer = null; }
      this._failPending();
      if (this.ws) {
        try {
          if (this.ws.readyState === 1) this._raw(new Uint8Array([0xe0, 0x00]));
          this.ws.close();
        } catch (e) { /* ignore */ }
      }
      this.connected = false;
    }
  }

  TP.Mqtt = Mqtt;
  TP.mqttMsgId = msgId;

  // 供测试脚本使用（Node 里也能 require 到编码函数）
  TP._mqttInternal = { encLen, u16, str, pack };

})(typeof globalThis !== 'undefined' ? globalThis : this);
