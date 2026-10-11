import { check } from '../types.js';
import { DEFAULT_EXPLANATION_PROMPT } from '../quick-explanation.js';
import { explanationReadiness as readiness } from '../quick-explanation-policy.js';
import { settingsConfigurationScope, documentConfigurationScope } from '../device-config.js';

function connectionFor(project, profile, scope) {
  return project.agentConnectionsForScope(scope).config().connections.find(connection => connection.id === profile.connection_id);
}

/** Device model configuration shared by project quick chats; no legacy explanation calls or history. */
export default {
  quickExplanationConfig(scope) {
    scope = settingsConfigurationScope(this.config, scope);
    const profile = this.quickExplanationSettings.read(scope);
    let reason;
    try { reason = readiness(connectionFor(this, profile, scope), profile); }
    catch { reason = '模型来源配置不可用，请检查模型来源页面'; }
    return { version: 1, ...profile, default_prompt: DEFAULT_EXPLANATION_PROMPT, ready: reason === null, reason,
      configuration_scope: typeof this.quickExplanationSettings.configurationScope === 'function'
        ? this.quickExplanationSettings.configurationScope(scope) : documentConfigurationScope(this.config, scope, 'quick-explanation.json') };
  },

  configureQuickExplanation(patch, scope) {
    scope = settingsConfigurationScope(this.config, scope);
    this.assertWritable('configure quick chat model');
    check(!this.stopping, 'daemon is stopping');
    const profile = this.quickExplanationSettings.preview(patch, scope);
    if (profile.connection_id) {
      const connection = connectionFor(this, profile, scope);
      const reason = readiness(connection, profile, false);
      check(!reason, reason || '对话来源无效');
      if (profile.model && connection.models?.length) check(connection.models.includes(profile.model), '对话模型不在所选来源的模型范围内');
    }
    this.quickExplanationSettings.save(profile, scope);
    return this.quickExplanationConfig(scope);
  },
};
