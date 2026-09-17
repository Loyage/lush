import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Runtime configuration, read from the environment by the daemon at startup. */
export class Config {
  constructor({ home, provider = 'mock', callTimeout = 120, maxRounds = 12 }) {
    this.home = home;
    this.provider = provider;
    this.callTimeout = callTimeout;
    this.maxRounds = maxRounds;
  }

  get socket() {
    return path.join(this.home, 'lush.sock');
  }

  static fromEnv(env = process.env) {
    const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    let home = env.LUSH_HOME || path.join(base, 'lush');
    if (home === '~' || home.startsWith('~/')) home = path.join(os.homedir(), home.slice(1));
    home = path.resolve(home);

    const timeout = Number.parseFloat(env.LUSH_CALL_TIMEOUT ?? '120');
    const rounds = Number.parseInt(env.LUSH_MAX_ROUNDS ?? '12', 10);
    if (!Number.isFinite(timeout) || !(timeout > 0 && timeout <= 86_400)
      || !Number.isInteger(rounds) || !(rounds >= 1 && rounds <= 100)) {
      throw new Error('invalid LUSH_CALL_TIMEOUT or LUSH_MAX_ROUNDS');
    }
    return new Config({ home, provider: env.LUSH_PROVIDER || 'mock', callTimeout: timeout, maxRounds: rounds });
  }

  prepare() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    if (fs.statSync(this.home).uid !== process.getuid()) {
      throw new Error('LUSH_HOME must belong to the current user');
    }
    fs.chmodSync(this.home, 0o700);
    if (Buffer.byteLength(this.socket) > 103) {
      throw new Error('Unix socket path is too long; choose a shorter LUSH_HOME');
    }
  }
}
