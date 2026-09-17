/**
 * Bun's socket.write() accepts only a bounded number of bytes per call and
 * returns how many it took; the rest must be retried when `drain` fires.
 * This writer keeps the unwritten tail queued so callers can write any size.
 */
export function createWriter(socket) {
  const queue = [];
  let ending = false;
  let ended = false;
  let dead = false;

  const finish = () => {
    if (!ending || ended || dead || queue.length) return;
    ended = true;
    try {
      socket.end();
    } catch {
      /* already gone */
    }
  };

  const flush = () => {
    if (dead) return;
    while (queue.length) {
      const chunk = queue[0];
      let written;
      try {
        written = socket.write(chunk);
      } catch {
        dead = true;
        queue.length = 0;
        return;
      }
      if (typeof written !== 'number' || written < 0) {
        dead = true;
        queue.length = 0;
        return;
      }
      if (written === 0) return; // backpressure: wait for drain
      if (written >= chunk.length) {
        queue.shift();
        continue;
      }
      queue[0] = chunk.subarray(written);
      return;
    }
    finish();
  };

  return {
    write(data) {
      if (dead) return;
      queue.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      flush();
    },
    drain: flush,
    /** Flush everything, then close the socket. */
    end() {
      ending = true;
      flush();
    },
    /** Abandon queued bytes (peer is gone). */
    fail() {
      dead = true;
      queue.length = 0;
    },
    get pending() {
      return queue.length;
    },
  };
}
