"use strict";

// TopologySync is the client-side queue behind the topology editor's draft
// sync (see docs/superpowers/specs/2026-08-27-topology-draft-sync-design.md,
// "Клиентский поток"). It owns exactly two pieces of state: the last
// confirmed server snapshot and the queue of operations not yet confirmed.
// The visible projection is always confirmed + every still-queued op applied
// in order, so the UI never regresses while a write is in flight.
//
// Deliberately decoupled from Api/apiPath/fetch/DOM: the caller injects
// read/write/apply/reload as plain functions, so this module has no idea
// it's talking to a draft over HTTP. That's what topology.js (Task 4) is for.
//
// onStatus contract (three states, matching the spec's "Сохраняется" /
// "Сохранено" / "Ошибка синхронизации"):
//   "saving" - a write is in flight (reported once per drain, not per op)
//   "saved"  - the queue fully drained with no error
//   "error"  - the last write failed (409/422/network); state was reconciled
//              against the server and nothing was auto-retried
const TopologySync = (() => {
  const SAVING = "saving";
  const SAVED = "saved";
  const ERROR = "error";

  // Operation kinds whose only meaningful content is "where is this object
  // now" - repeated moves of the same target queued before the first one
  // sends collapse to just the last position (see spec: "Операции
  // перемещения ... сворачиваются до последней позиции для одного
  // объекта"). Field names/values mirror internal/httpapi/dto.go's
  // topologyOperation.Kind.
  const MOVE_KINDS = new Set(["set-device-position", "set-network-position", "set-link-waypoints", "set-camera"]);

  // moveKey returns the coalescing identity for a move operation, or null if
  // `op` isn't a move (or a move without an identifiable target) and must
  // never be coalesced. A link's target is its canonical (order-independent)
  // endpoint pair, matching the server's canonicalLink/layoutLinkKey.
  function moveKey(op) {
    if (!op || !MOVE_KINDS.has(op.kind)) return null;
    switch (op.kind) {
      case "set-device-position":
        return op.deviceName === undefined ? null : `${op.kind}:${op.deviceName}`;
      case "set-network-position":
        return op.networkName === undefined ? null : `${op.kind}:${op.networkName}`;
      case "set-link-waypoints": {
        const a = op.link?.a?.device;
        const b = op.link?.b?.device;
        if (a === undefined || b === undefined) return null;
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return `${op.kind}:${lo}:${hi}`;
      }
      case "set-camera":
        return op.kind; // singleton target
      default:
        return null;
    }
  }

  // coalesce appends `op` to `queue`, replacing an earlier not-yet-sent move
  // of the same target instead of piling up redundant intermediate
  // positions. Never touches an operation already sent (that's `sending`,
  // tracked outside `queue` by the caller) - only queued-but-unsent ops.
  function coalesce(queue, op) {
    const key = moveKey(op);
    if (key === null) return [...queue, op];
    const i = queue.findIndex((p) => moveKey(p) === key);
    if (i === -1) return [...queue, op];
    const next = queue.slice();
    next[i] = op;
    return next;
  }

  function create({ read, write, apply, onState, onStatus, reload }) {
    let confirmed = null;
    let queue = []; // not-yet-sent operations, in order
    let sending = null; // the one operation currently being written, or null
    let inFlight = false;
    let drainPromise = Promise.resolve();

    // publish recomputes the visible projection: confirmed snapshot with the
    // in-flight op (if any) and every still-queued op re-applied in order.
    function publish() {
      let snapshot = confirmed;
      if (sending) snapshot = apply(snapshot, sending);
      for (const op of queue) snapshot = apply(snapshot, op);
      onState(snapshot);
    }

    // reconcile handles every write failure (409, 422, network error) the
    // same way: never auto-retry (the topology may have changed underneath
    // the queued op), reload the canonical snapshot, discard everything
    // pending, publish, and report. reload() itself is injected (e.g. an
    // Api.get call) and can also fail - if it does, there's no fresher
    // snapshot to publish, so `confirmed` is left as whatever it last was;
    // the discarded queue still can't be trusted (that's why we're here),
    // so it stays discarded either way. What must never happen: drain()
    // left permanently inFlight (wedging every future enqueue) or a
    // silently-stuck status. So this always ends by clearing inFlight and
    // reporting ERROR, reload failure or not.
    async function reconcile() {
      queue = [];
      try {
        confirmed = await reload();
      } catch {
        // Keep the last known-good confirmed snapshot; fall through to
        // publish/unwedge/report below regardless.
      }
      publish();
      inFlight = false;
      onStatus(ERROR);
    }

    async function drain() {
      inFlight = true;
      onStatus(SAVING);
      while (queue.length || sending) {
        if (!sending) sending = queue.shift();
        try {
          confirmed = await write(sending);
          sending = null;
          publish();
        } catch {
          sending = null;
          await reconcile();
          return;
        }
      }
      inFlight = false;
      onStatus(SAVED);
    }

    function seed(snapshot) {
      confirmed = snapshot;
      queue = [];
      sending = null;
      publish();
    }

    function enqueue(op) {
      queue = coalesce(queue, op);
      publish();
      if (!inFlight) drainPromise = drain();
    }

    function idle() {
      return drainPromise;
    }

    // pending exposes every operation not yet confirmed by the server - the
    // in-flight one (if any) plus the still-queued ones - so a caller can
    // tell "still pending" from "confirmed" (e.g. to gate an action on a
    // just-created link until its create op lands).
    function pending() {
      return sending ? [sending, ...queue] : [...queue];
    }

    return { seed, enqueue, idle, pending };
  }

  return { create };
})();

export { TopologySync };
