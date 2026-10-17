export function createStreamingLifecycle({ res, onEvent, provider, signal }) {
  let terminal = false;
  let request;
  let source;
  const removeListeners = () => {
    signal?.removeEventListener('abort', cancel);
    res.removeListener('close', onClose);
  };
  const release = () => {
    removeListeners();
    if (source && !source.destroyed) source.destroy();
    if (request && !request.destroyed) request.destroy();
  };
  const cancel = () => {
    if (terminal) return;
    terminal = true;
    release();
  };
  const fail = (error) => {
    if (terminal || signal?.aborted || res.destroyed) return;
    terminal = true;
    const payload = error.toEvent().error;
    onEvent({ type: 'error', provider, error: payload });
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: payload })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    } else {
      respondJson(res, error.status || 502, { error: payload });
    }
    release();
  };
  const complete = () => {
    if (terminal) return;
    terminal = true;
    removeListeners();
    if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    if (source && !source.destroyed) source.destroy();
  };
  const onClose = () => {
    if (!res.writableEnded) cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  res.once('close', onClose);
  return {
    get terminal() { return terminal; },
    setRequest(value) {
      request = value;
      if (terminal && !request.destroyed) request.destroy();
    },
    setSource(value) {
      source = value;
      if (terminal && !source.destroyed) source.destroy();
    },
    cancel,
    fail,
    complete,
  };
}

function respondJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
