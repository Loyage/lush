import { readTranscript, readUsage } from '../transcript.js';
import { readUsageStatistics } from '../usage-statistics.js';

/** pi 会话记录的只读投影。 */
export default {
  /** Read-only agent process log from pi's session files; never touches the database. */
  transcript(taskId, after = 0, limit = 100) {
    this.store.task(taskId);
    return readTranscript(this.config, taskId, after, limit);
  },

  /** Read-only agent usage (model, context, cost) from the same session files, without the bodies. */
  usageStatistics(options) { return readUsageStatistics(this.config, options); },

  usage(taskId) {
    this.store.task(taskId);
    return readUsage(this.config, taskId);
  }
};
