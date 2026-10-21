// A Cloudflare world in memory for the versus tests (match_test.mjs, vs_stress.mjs): Durable Objects by name, each
// with its storage (a Map, plus SQLite for the ladder), its alarm and its WebSockets, and a clock the test moves.
//
// Like the real thing, an object handles one event at a time (its input gate): an event runs alone until it waits on
// something outside the object (another object, the assets), when the next event may start; blockConcurrencyWhile
// keeps the object to itself throughout. The phones are FakeClients: what the room sends lands in their inbox.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Match, resetEngine } from './match.js';

const RealResponse = globalThis.Response;
if (!globalThis.WebSocketPair || !globalThis.WebSocketPair.fake) {
  globalThis.Response = class extends RealResponse {
    constructor(body, init = {}) { super(body, init.status === 101 ? { status: 200 } : init); this.webSocket = init.webSocket; this.realStatus = init.status ?? 200; }
  };
  globalThis.WebSocketPair = class {
    constructor() { const c = new FakeSocket(), s = new FakeSocket(); c.peer = s; s.peer = c; this[0] = c; this[1] = s; }
  };
  globalThis.WebSocketPair.fake = true;
}

class FakeSocket {
  constructor() { this.peer = null; this.closed = false; this.att = null; this.tags = []; this.onmessage = null; this.onclose = null; this.world = null; this.obj = null; this.code = 0; }
  send(s) {
    if (this.closed) throw new Error('closed');
    if (typeof s !== 'string') throw new Error('text only');
    const p = this.peer;
    if (p.obj) p.world.deliver(p.obj, p, s);                     // client -> server: the object's webSocketMessage
    else if (p.onmessage) p.onmessage(s);                           // server -> client: the phone's inbox
    else (p.buffer || (p.buffer = [])).push(s);                     // (not listening yet: held, as a real socket does)
  }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true; this.code = code;
    const p = this.peer;
    if (p.closed) return;
    p.closed = true; p.code = code;
    if (p.obj) p.world.closed(p.obj, p);                           // the phone went: the object's webSocketClose
    else if (p.onclose) p.onclose({ code });
  }
  serializeAttachment(a) { this.att = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.att); }
}

class Gate {           // a lock: one event at a time
  constructor() { this.busy = false; this.q = []; }
  async enter() { if (!this.busy) { this.busy = true; return; } await new Promise((r) => this.q.push(r)); }
  leave() { const n = this.q.shift(); if (n) n(); else this.busy = false; }
}

function sqlFor() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...args) {
      const st = db.prepare(query), isRead = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query);
      if (/^\s*CREATE/i.test(query)) { db.exec(query); return { toArray: () => [], one: () => { throw new Error('no row'); } }; }
      const rows = isRead ? st.all(...args.map((a) => (typeof a === 'boolean' ? Number(a) : a))) : (st.run(...args.map((a) => (typeof a === 'boolean' ? Number(a) : a))), []);
      const plain = rows.map((r) => ({ ...r }));
      return { toArray: () => plain, one: () => { if (plain.length !== 1) throw new Error(`one: ${plain.length} rows`); return plain[0]; } };
    },
  };
}

export class World {
  constructor({ assetsDir = null, engine = null, start = 1_700_000_000_000 } = {}) {
    this.now = start;
    this.objects = new Map();
    this.als = new AsyncLocalStorage();
    this.errors = [];
    this.timers = [];
    this.realNow = Date.now;
    Date.now = () => this.now;
    resetEngine();
    const world = this;
    this.env = {
      ASSETS: { fetch: (req) => world.outside(async () => {
        const p = new URL(req.url).pathname.replace(/^\/+/, '');
        const f = assetsDir && path.join(assetsDir, p);
        if (!f || !fs.existsSync(f)) return new RealResponse('not found', { status: 404 });
        return new RealResponse(fs.readFileSync(f));
      }) },
      MATCH: { idFromName: (n) => n, get: (id) => ({ fetch: (req) => world.outside(() => world.run(id, (o) => o.m.fetch(req))) }) },
    };
    if (engine) this.env.VS_ENGINE = engine;
  }
  close() { Date.now = this.realNow; }

  obj(name) {
    let o = this.objects.get(name);
    if (o) return o;
    const store = new Map(), sockets = [];
    o = { name, store, sockets, alarm: null, gate: new Gate(), bcw: 0 };
    const world = this;
    o.ctx = {
      storage: {
        get: async (k) => structuredClone(store.get(k)),
        put: async (k, v) => { store.set(k, structuredClone(v)); },
        delete: async (k) => store.delete(k),
        deleteAll: async () => store.clear(),
        getAlarm: async () => o.alarm,
        setAlarm: async (t) => { o.alarm = typeof t === 'number' ? t : +t; },
        deleteAlarm: async () => { o.alarm = null; },
        get sql() { if (!o.sql) o.sql = sqlFor(); return o.sql; },
      },
      acceptWebSocket: (ws, tags) => { ws.tags = tags || []; ws.obj = o; ws.world = world; sockets.push(ws); },
      getWebSockets: (tag) => sockets.filter((w) => !w.closed && (!tag || w.tags.includes(tag))),
      blockConcurrencyWhile: async (fn) => { o.bcw += 1; try { return await fn(); } finally { o.bcw -= 1; } },
    };
    o.m = new Match(o.ctx, this.env);
    this.objects.set(name, o);
    return o;
  }

  // an event for an object: alone, unless it waits on the outside
  async run(name, fn) {
    const o = this.obj(name);
    await o.gate.enter();
    try { return await this.als.run(o, () => fn(o)); } catch (e) { this.errors.push(`${name}: ${e && e.stack}`); throw e; } finally { o.gate.leave(); }
  }
  // waiting on the outside: the object's gate opens meanwhile (not inside blockConcurrencyWhile)
  async outside(fn) {
    const o = this.als.getStore();
    if (!o || o.bcw) return fn();
    o.gate.leave();
    try { return await this.als.exit(fn); } finally { await o.gate.enter(); }
  }
  deliver(o, ws, raw) { this.pending = (this.pending || 0) + 1; this.run(o.name, (x) => x.m.webSocketMessage(ws, raw)).catch(() => {}).finally(() => { this.pending -= 1; }); }
  closed(o, ws) { this.pending = (this.pending || 0) + 1; this.run(o.name, (x) => x.m.webSocketClose(ws)).catch(() => {}).finally(() => { this.pending -= 1; }); }
  // let every event in flight finish (the microtask queue and the gates drain)
  async settle() {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (!this.pending && [...this.objects.values()].every((o) => !o.gate.busy)) {
        await new Promise((r) => setImmediate(r));
        if (!this.pending) return;
      }
    }
  }
  // something a phone does later (the tests' players): at world time now + ms
  later(ms, fn) { this.timers.push({ at: this.now + Math.max(0, ms), fn, id: this.tid = (this.tid || 0) + 1 }); }
  // the clock moves: every alarm and timer due on the way goes off, in order
  async advance(ms) {
    const until = this.now + ms;
    for (;;) {
      await this.settle();
      let next = null, at = Infinity;
      for (const o of this.objects.values()) if (o.alarm != null && o.alarm <= until && o.alarm < at) { next = o; at = o.alarm; }
      let ti = -1;
      this.timers.forEach((t, i) => { if (t.at <= until && (t.at < at || (t.at === at && next === null))) { at = t.at; ti = i; } });
      if (ti >= 0) {
        const t = this.timers.splice(ti, 1)[0];
        this.now = Math.max(this.now, t.at);
        try { await t.fn(); } catch (e) { this.errors.push(`timer: ${e && e.stack}`); }
        continue;
      }
      if (!next) break;
      this.now = Math.max(this.now, next.alarm);
      next.alarm = null;
      await this.run(next.name, (o) => o.m.alarm()).catch(() => {});
    }
    this.now = until;
    await this.settle();
  }

  // a phone: a socket to a room or the lobby, its inbox
  async connect(pathq, name, headers = {}) {
    const res = await this.run(name, (o) => o.m.fetch(new Request(`https://w${pathq}`, { headers: { Upgrade: 'websocket', ...headers } })));
    await this.settle();
    return res;
  }
  async http(name, pathq, body) {
    const res = await this.run(name, (o) => o.m.fetch(new Request(`https://w${pathq}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })));
    return { status: res.realStatus ?? res.status, body: await res.json() };
  }
}

// a phone's connection to a room: what it got, in order
export class FakeClient {
  constructor(world, key) { this.world = world; this.key = key; this.inbox = []; this.ws = null; this.closedWith = null; this.handlers = []; }
  async open(room, { mode = '', since = 0 } = {}) {
    const res = await this.world.connect(`/vs/ws?room=${room}&key=${this.key}${mode ? `&mode=${mode}` : ''}&since=${since}`, `room:${room}`);
    if ((res.realStatus ?? res.status) !== 101) return res.realStatus ?? res.status;
    this.attach(res.webSocket);
    await this.world.settle();
    return 101;
  }
  async queue({ ip, ...q }) {        // (ip: the phone's address, as Cloudflare tells the worker: CF-Connecting-IP)
    const res = await this.world.connect(`/vs/queue?key=${this.key}&${new URLSearchParams(q)}`, 'lobby', ip ? { 'CF-Connecting-IP': ip } : {});
    if ((res.realStatus ?? res.status) !== 101) return res.realStatus ?? res.status;
    this.attach(res.webSocket);
    await this.world.settle();
    return 101;
  }
  attach(ws) {
    this.ws = ws; this.closedWith = null;
    ws.onmessage = (s) => { const m = JSON.parse(s); this.inbox.push(m); this.handlers.forEach((h) => h(m)); };
    ws.onclose = (e) => { this.closedWith = e.code; };
    for (const s of ws.buffer || []) ws.onmessage(s);
    ws.buffer = [];
    if (ws.closed) this.closedWith = ws.code;
  }
  send(m) { if (this.ws && !this.ws.closed) this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  drop() { if (this.ws && !this.ws.closed) this.ws.close(1006); }
  last(t) { return [...this.inbox].reverse().find((m) => m.t === t); }
  all(t) { return this.inbox.filter((m) => m.t === t); }
}
