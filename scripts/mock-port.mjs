// Development-only stand-in for the classification Port. No network access.
export function mockConnect(classify) {
  return () => {
    const listeners = new Set(), disconnects = new Set(), pending = new Map();
    let closed = false;
    const emit = message => { if (!closed) for (const fn of listeners) fn(message); };
    return {
      onMessage: { addListener: fn => listeners.add(fn) },
      onDisconnect: { addListener: fn => disconnects.add(fn) },
      postMessage(message) {
        if (closed) throw new Error("Disconnected");
        if (message.type === "subscribe") {
          pending.set(message.requestId, message);
          queueMicrotask(() => emit({ type: "check", requestId: message.requestId, checkId: message.requestId, aiRevision: message.aiRevision }));
        } else if (message.type === "cancel") pending.delete(message.requestId);
        else if (message.type === "relevance") {
          const request = pending.get(message.requestId);
          if (!request) return;
          if (!message.eligible) { pending.delete(message.requestId); return; }
          Promise.resolve(classify({ ...request, type: "classify-title" })).then(result => {
            if (pending.get(message.requestId) !== request) return;
            pending.delete(message.requestId);
            emit({ ...result, type: "result", requestId: message.requestId });
          }, () => {
            pending.delete(message.requestId);
            emit({ type: "result", requestId: message.requestId, ok: false, code: "network", retryAt: Date.now() + 30000 });
          });
        }
      },
      disconnect() { if (!closed) { closed = true; pending.clear(); for (const fn of disconnects) fn(); } }
    };
  };
}
