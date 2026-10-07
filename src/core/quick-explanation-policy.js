import { EXPLANATION_PROVIDERS } from './quick-explanation.js';

/** Configuration readiness is local validation, not a probe or a promise that a request will succeed. */
export function explanationReadiness(connection, profile, requireModel = true) {
  if (!profile.connection_id) return '请在快捷解释页面选择模型来源';
  if (!connection) return '解释模型来源已不存在，请重新选择';
  if (!EXPLANATION_PROVIDERS.has(connection.provider) || connection.auth_type !== 'api_key') return '快捷解释只支持 OpenAI 兼容 API Key 来源，不支持此协议或 OAuth';
  if (!connection.enabled) return '解释模型来源已禁用';
  if (connection.credential?.status !== 'configured') return '解释模型来源尚未配置 API Key';
  if (!requireModel) return null;
  if (!profile.model) return '请在快捷解释页面填写物理模型 ID';
  if (connection.models?.length && !connection.models.includes(profile.model)) return '解释模型不在所选来源的模型范围内';
  return null;
}
