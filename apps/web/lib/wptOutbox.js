// Offline-safe outbox for the Web chat. Same verified contract as the
// retired web outbox: enqueue/dedupe/pending/failed/retry/markSent/clear.
// UMD so it is both require()able by the verification harness (Node) and
// usable in the browser (Next.js client binds it to localStorage).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.wptOutbox = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function createOutbox(load, save) {
    function read() {
      let list = [];
      if (typeof load === "function") {
        try {
          const v = load();
          if (Array.isArray(v)) list = v;
        } catch (e) {}
      }
      return list;
    }
    function write(list) {
      if (typeof save === "function") {
        try {
          save(list);
        } catch (e) {}
      }
    }
    function enqueue(entry) {
      if (!entry || entry.id == null) return null;
      const list = read();
      const existing = list.find((m) => String(m.id) === String(entry.id));
      if (existing) return existing;
      const item = {
        id: entry.id,
        chatId: entry.chatId || null,
        tmpId: entry.tmpId || null,
        from: entry.from || null,
        to: entry.to || null,
        text: entry.text || "",
        status: "pending",
        attempts: 0,
        queuedAt: Date.now(),
      };
      list.push(item);
      write(list);
      return item;
    }
    function all() {
      return read();
    }
    function pending() {
      return read().filter((m) => m.status === "pending");
    }
    function failed() {
      return read().filter((m) => m.status === "failed");
    }
    function byId(id) {
      return read().find((m) => String(m.id) === String(id)) || null;
    }
    function markSent(id) {
      const list = read();
      const i = list.findIndex((m) => String(m.id) === String(id));
      if (i < 0) return;
      list.splice(i, 1);
      write(list);
    }
    function markFailed(id) {
      const list = read();
      const m = list.find((x) => String(x.id) === String(id));
      if (!m) return;
      m.status = "failed";
      m.attempts = (m.attempts || 0) + 1;
      m.updatedAt = Date.now();
      write(list);
    }
    function retry(id) {
      const list = read();
      const m = list.find((x) => String(x.id) === String(id));
      if (!m) return;
      m.status = "pending";
      m.updatedAt = Date.now();
      write(list);
    }
    function count() {
      const c = { pending: 0, failed: 0 };
      for (const m of read()) {
        if (m.status === "failed") c.failed++;
        else c.pending++;
      }
      return c;
    }
    function clear() {
      write([]);
    }
    return { enqueue, all, pending, failed, byId, markSent, markFailed, retry, count, clear };
  }
  return { createOutbox };
});