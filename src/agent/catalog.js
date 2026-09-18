/**
 * Which provider answers for which service.
 *
 * The catalog is the one place that turns "a service selected agent X" into a
 * live provider: it reads the profile from disk *at that moment* (so editing
 * `$LUSH_HOME/agents/<name>.json` takes effect on the next call, no daemon
 * restart), resolves it against the environment, and builds (or reuses) the
 * backend. Instances are cached by their resolved fields, so a profile edit
 * that changes nothing effective keeps the same provider.
 *
 * The daemon creates one catalog at startup and binds it to the runtime; the
 * library's `configuredProvider()` is a thin async wrapper over it.
 */
import { LushError } from '../core/types.js';
import { DEFAULT_AGENT_NAME, ProfileStore, resolveAgentSpec } from './profiles.js';
import { PiAgentProvider } from './pi.js';
import { MockAgentProvider } from './mock.js';
import { OpenAICompatibleProvider } from './openai.js';

/**
 * A synthetic invocation used only to show the argv a profile would run
 * (`lush agent inspect`). The prompt pieces are placeholders, not secrets.
 */
export function previewInvocation() {
  return {
    task_id: 0,
    sid: 0,
    prompt: '<PROMPT>',
    system_prompt: '<SYSTEM_PROMPT>',
    guide: '<LUSH_GUIDE>',
    context: { service: { sid: 0, name: '<SERVICE>' } },
    cwd: null,
  };
}

export class AgentCatalog {
  constructor({ home, env = process.env }) {
    if (typeof home !== 'string' || home === '') {
      throw new LushError('agent catalog requires the Lush home directory', -32602);
    }
    this.home = home;
    this.env = env;
    this.store = new ProfileStore(home);
    /** resolved-field key -> provider instance; a profile edit changes the key. */
    this.providers = new Map();
  }

  /** The effective spec of one profile (`null` / `default` = the fallback tier). */
  spec(name = null) {
    const target = name === null || name === undefined ? DEFAULT_AGENT_NAME : name;
    return resolveAgentSpec(this.store.read(target), { name: target, env: this.env });
  }

  /** The backend for one spec. Unknown providers and missing commands throw here. */
  provider(spec) {
    const key = [
      spec.provider, spec.command, spec.pi_provider, spec.model,
      spec.plugins === true ? 'plugins' : 'pure', (spec.flags ?? []).join('\u0000'),
    ].join('\u0001');
    const cached = this.providers.get(key);
    if (cached !== undefined) return cached;
    const built = this.build(spec);
    this.providers.set(key, built);
    return built;
  }

  build(spec) {
    if (spec.provider === 'pi') return PiAgentProvider.fromSpec(spec, this.env, { home: this.home });
    if (spec.provider === 'mock') return new MockAgentProvider();
    if (spec.provider === 'openai') return OpenAICompatibleProvider.fromEnv(this.env);
    throw new LushError(`unknown agent provider: ${spec.provider} (choose pi, mock or openai)`, -32602);
  }

  /** The provider of the `default` profile (env over the built-in fallbacks). */
  defaultProvider() {
    return this.provider(this.spec(null));
  }

  /**
   * The command line one profile would run, without requiring its binary to be
   * installed: `lush agent inspect` must be able to explain a profile on a
   * machine that cannot run it yet.
   */
  preview(spec) {
    if (spec.provider !== 'pi') {
      throw new LushError(
        `agent ${spec.name} runs in-service (${spec.provider}); there is no external command line`,
        -32020,
      );
    }
    return PiAgentProvider.forPreview(spec, this.env, { home: this.home }).preview(previewInvocation());
  }
}
