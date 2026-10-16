import { FrameDecoder } from './transport.js';
import { LIMITS, PROTOCOL_VERSION } from './protocol.js';

/** Serve one authenticated SSH/stdio connection. No network listener or shell command parsing. */
export function serveConnection(node, { input = process.stdin, output = process.stdout } = {}) {
  const session_id = node.openSession();
  const inflight = new Set();
  let stopping = false, negotiated = false, writeQueue = Promise.resolve();
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const write = response => {
    let line = JSON.stringify(response) + '\n';
    if (Buffer.byteLength(line) > LIMITS.frame_bytes) line = JSON.stringify({ version: PROTOCOL_VERSION,
      request_id: response.request_id, error: { code: 'LIMIT_EXCEEDED', message: 'Runner response exceeds frame limit; use bounded reads' } }) + '\n';
    writeQueue = writeQueue.then(() => new Promise(resolve => {
      if (output.destroyed) return resolve();
      output.write(line, () => resolve());
    }));
    return writeQueue;
  };
  const stop = async error => {
    if (stopping) return;
    stopping = true;
    input.pause();
    try {
      // Invalidate the connection before awaiting outstanding request completion.
      await node.disconnect(session_id);
      await Promise.allSettled([...inflight]);
      await writeQueue;
      if (error) rejectDone(error); else resolveDone();
    } catch (failure) { rejectDone(failure); }
    finally {
      input.removeListener('data', onData); input.removeListener('end', onEnd);
      input.removeListener('error', onError); output.removeListener('error', onError);
    }
  };
  const decoder = new FrameDecoder(frame => {
    if (stopping) return;
    if (inflight.size >= LIMITS.max_pending) { void stop(new Error('Runner inflight limit exceeded')); return; }
    const work = (!negotiated && frame?.method !== 'hello'
      ? Promise.resolve({ version: PROTOCOL_VERSION, request_id: typeof frame?.request_id === 'string' ? frame.request_id : null,
        error: { code: 'UNAUTHORIZED', message: 'Runner handshake is required before operation admission' } })
      : node.dispatch(frame, session_id)).then(response => {
        if (frame?.method === 'hello' && !response.error) negotiated = true;
        return write(response);
      });
    inflight.add(work); work.finally(() => inflight.delete(work)).catch(() => {});
  });
  const onData = chunk => { try { decoder.push(chunk); } catch (error) { void stop(error); } };
  const onEnd = () => { try { decoder.end(); void stop(); } catch (error) { void stop(error); } };
  const onError = error => { void stop(error); };
  input.on('data', onData); input.on('end', onEnd); input.on('error', onError); output.on('error', onError);
  return { session_id, done, stop: () => stop() };
}
