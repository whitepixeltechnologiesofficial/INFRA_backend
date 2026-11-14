// Shared harness helpers for the @wpt/web verification suites.
// Each suite spawns its OWN wpt-server.mjs on a unique port, so the suites
// are independent and never touch each other's QR/session/chat state.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const APP_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function httpWait(port) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" })
        .then(async (r) => (r.ok ? resolve() : tick()))
        .catch(() => tick());
    };
    const tick = () => {
      if (Date.now() - t0 > 15000) return reject(new Error(`server on :${port} did not become healthy`));
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

export function startServer(port, { qrTtlMs, typingTtlMs } = {}) {
  const env = { ...process.env, PORT: String(port) };
  if (qrTtlMs != null) env.QR_TTL_MS = String(qrTtlMs);
  if (typingTtlMs != null) env.TYPING_TTL_MS = String(typingTtlMs);
  const child = spawn(process.execPath, ["server/wpt-server.mjs"], { cwd: APP_ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
  return { child, ready: httpWait(port) };
}

export function stopServer(server) {
  try {
    server.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

export async function http(port, method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" }, cache: "no-store" };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  } catch (err) {
    return { status: 0, ok: false, json: null };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

export function wsClient(port, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const raw = new WebSocket(`ws://127.0.0.1:${port}/?${qs}`);
  const events = [];
  const waiters = [];
  const api = {
    events,
    raw,
    ready: new Promise((resolve, reject) => {
      raw.once("open", resolve);
      raw.once("error", reject);
    }),
    waitEvent(type, { timeout = 8000, predicate } = {}) {
      const existing = events.find((m) => m.type === type && (!predicate || predicate(m)));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null, matches: (m) => m.type === type && (!predicate || predicate(m)) };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ws event ${type}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    expectNoEvent(type, { within = 1200 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(true), within);
        const probe = (m) => {
          if (m.type === type) {
            clearTimeout(timer);
            reject(new Error(`unexpected event ${type} while none expected`));
          }
        };
        api._noEventProber = probe;
        raw.on("message", probe);
      });
    },
    close() {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
    },
  };
  raw.on("message", (data) => {
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      msg = null;
    }
    if (!msg) return;
    events.push(msg);
    if (api._noEventProber) api._noEventProber(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.matches(msg)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });
  return api;
}

export class Suite {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
    this.checked = [];
  }

  check(name, cond, extra) {
    if (cond) {
      this.passed += 1;
      console.log(`  PASS  ${name}`);
    } else {
      this.failed += 1;
      console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    }
    this.checked.push(name);
  }

  section(title) {
    console.log(`-- ${title}`);
  }

  summary() {
    const ok = this.failed === 0;
    console.log(`\n${this.name}: ${this.passed}/${this.passed + this.failed} PASS${ok ? "" : ` (${this.failed} FAILED)`}`);
    return ok;
  }
}