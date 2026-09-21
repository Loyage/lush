import { discoverAgentModels } from '../../agent/models.js';
import { discoverAgentResources } from '../../agent/resources.js';

/** Project-level Agent configuration. Running invocations keep their resolved profile; the next call re-reads it. */
export default {
  agentConfig() { return this.agentSettings.get(); },
  agentModels(agent) { return discoverAgentModels(this.config, agent); },
  agentResources() { return discoverAgentResources(this.config); },
  configureAgents(value) { return this.agentSettings.save(value); },
};
