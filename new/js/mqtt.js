/**
 * mqtt.js —— 浏览器直连 EMQX（WebSocket），无第三方依赖
 *
 * 自己实现 MQTT 3.1.1 协议里的最小子集：CONNECT/CONNACK/SUBSCRIBE/PUBLISH/PINGREQ。
 * 不支持 QoS1/2（订阅用 QoS0，够面板用）。
 */
(function (global) {
  'use strict';

  const TP = global.TP;
  const CFG = TP.CFG;

  const WS = global.WebSocket;

  // ---------- 协议常量 ----------
  const C = {
    CONNECT: 0x10, CONNACK: 0x20,
    PUBLISH: 0x30, SUBSCRIBE: 0x82,
    PINGREQ: 0xc0, PINGRESP: 0xd0,
    UNSUB: 0xa2,
  };

  const state = {
    ws: null,
    online: false,
    retry: 0,
    timer: null,
    ping: null,
    msgId: 1,
    pending: [],      // 离线期间的命令，重连后按序发送
    queue: [],        // 待 PUBLISH 队列
    handlers: {},     // topic -> fn
    onState: null,    // (conn) 回调
  };

  function nextId() { return state.msgId++ & 0xffff; }

  function conn() {
    return {
      online: state.online,
      retry: state.retry,
      status: state.online ? 'online' : (state.retry ? 'retry' : 'connecting'),
    };
  }

  function emit() {
    if (state.onState) try { state.onState(conn()); } catch (e) { /* ignore */ }
  }

  // ---------- 编码 ----------

  function utf8(s) { return new TextEncoder().encode(s); }

  function encLen(n) {
    const out = [];
    do {
      let b = n % 128; n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function buildPacket(type, body) {
    const len = encLen(body.length);
    const buf = new Uint8Array(1 + len.length + body.length);
    buf[0] = type;
    buf.set(len, 1);
    buf.set(body, 1 + len.length);
    return buf;
  }

  function connectPacket() {
    const p = [];
    p.push(0, 4, ...utf8('MQTT'), 4 /* level 3.1.1 */, 0x02 /* clean session */);
    // keepalive 60s
    p.push(0, 60);
    // payload: clientId + username + password
    const cid = utf8('web_' + Math.random().toString(16).slice(2, 8));
    p.push(...encU16(cid.length), ...cid);
    if (CFG.username) {
      const u = utf8(CFG.username);
      p.push(...encU16(u.length), ...u);
    }
    if (CFG.password) {
      const pw = utf8(CFG.password);
      p.push(...encU16(pw.length), ...pw);
    }
    return buildPacket(C.CONNECT, new Uint8Array(p));
  }

  function encU16(n) { return [n >> 8, n & 0xff]; }

  function subscribePacket() {
    const t = utf8(CFG.subTopic);
    const body = new Uint8Array(2 + t.length + 3);
    body[0] = (nextId() >> 8) & 0xff; body[1] = nextId() & 0xff;
    body.set(t, 2);
    body[2 + t.length] = 0; // QoS0
    return buildPacket(C.SUBSCRIBE, body);
  }

  function publishPacket(topic, payload) {
    const t = utf8(topic);
    const pl = typeof payload === 'string' ? utf8(payload) : payload;
    const body = new Uint8Array(2 + t.length + pl.length);
    body.set(encU16(t.length), 0);
    body.set(t, 2);
    body.set(pl, 2 + t.length);
    return buildPacket(C.PUBLISH, body);
  }

  function pingPacket() {
    return buildPacket(C.PINGREQ, new Uint8Array(0));
  }

  // ---------- 解码 ----------

  function readVarInt(buf, i) {
    let v = 0, m = 1, k = 0;
    while (k < 4) {
      const b = buf[i + k];
      v += (b & 0x7f) * m;
      m *= 128;
      if (!(b & 0x80)) return [v, i + k + 1];
      k++;
    }
    return [0, i];
  }

  function parsePacket(buf) {
    const [len, i] = readVarInt(buf, 1);
    return { type: buf[0] & 0xf0, body: buf.subarray(i, i + len) };
  }

  // ---------- 对外 ----------

  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    state.retry++;
    emit();
    let ws;
    try {
      ws = new WS(CFG.url, ['mqtt']);
    } catch (e) {
      state.onState && state.onState({ online: false, retry: state.retry, status: 'error' });
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      ws.send(connectPacket());
      state.retry = 0;
    };

    ws.onmessage = function (ev) {
      const buf = new Uint8Array(ev.data);
      const pkt = parsePacket(buf);
      switch (pkt.type) {
        case C.CONNACK:
          if (pkt.body[1] === 0) {
            state.online = true;
            emit();
            ws.send(subscribePacket());
            // 补发离线期间的命令
            for (const q of state.pending.splice(0)) {
              ws.send(publishPacket(q.topic, q.payload));
            }
            startPing();
          } else {
            state.online = false;
            state.onState && state.onState({ online: false, retry: state.retry, status: 'error' });
            scheduleReconnect();
          }
          break;
        case C.PUBLISH: {
          const tlen = (pkt.body[0] << 8) | pkt.body[1];
          const topic = new TextDecoder().decode(pkt.body.subarray(2, 2 + tlen));
          const payload = pkt.body.subarray(2 + tlen);
          const h = state.handlers[topic];
          if (h) { try { h(payload, topic); } catch (e) { /* ignore handler err */ } }
          break;
        }
        case C.PINGRESP:
          break;
      }
    };

    ws.onclose = function () {
      state.online = false;
      stopPing();
      emit();
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose 会跟着来，统一在那重连
    };
  }

  function scheduleReconnect() {
    if (state.timer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, state.retry));
    state.timer = setTimeout(function () {
      state.timer = null;
      connect();
    }, delay);
  }

  function startPing() {
    stopPing();
    state.ping = setInterval(function () {
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(pingPacket());
      }
    }, 30000);
  }

  function stopPing() {
    if (state.ping) { clearInterval(state.ping); state.ping = null; }
  }

  function on(topic, fn) { state.handlers[topic] = fn; }

  function publish(topic, payload, { qos = 0, retained = false, offline = true } = {}) {
    if (state.online && state.ws && state.ws.readyState === 1) {
      state.ws.send(publishPacket(topic, payload));
    } else if (offline) {
      state.pending.push({ topic, payload });
    }
  }

  TP.mqtt = { connect, on, publish, state: conn };

})(typeof globalThis !== 'undefined' ? globalThis : this);