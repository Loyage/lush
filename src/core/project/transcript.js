import { readTranscript, readTranscriptLatest, readUsage } from '../transcript.js';
import { readUsageStatistics } from '../usage-statistics.js';
import { searchTranscript, transcriptStep, transcriptPage } from '../transcript-reader.js';

/** pi 会话记录的只读投影。 */
export default {
  /** Read-only agent process log from pi's session files; never touches the database. */
  transcript(taskId, after = 0, limit = 100) {
    this.store.task(taskId);
    return readTranscript(this.config, taskId, after, limit);
  },

  transcriptLatest(taskId, after = 0, before = 0, limit = 100) {
    this.store.task(taskId);
    return readTranscriptLatest(this.config, taskId, { after, before, limit });
  },

  transcriptPage(taskId, seq, offset) { this.store.task(taskId); return transcriptPage(this.config, taskId, seq, offset); },
  searchTranscript(taskId, options) { this.store.task(taskId); return searchTranscript(this.config, taskId, options); },
  transcriptStep(taskId, seq, offset) { this.store.task(taskId); return transcriptStep(this.config, taskId, seq, offset); },

  /** Read-only agent usage (model, context, cost) from the same session files, without the bodies. */
  usageStatistics(options) {
    return readUsageStatistics(this.config, options, {
      tasks: this.store.all('SELECT id,role,status,integration,substr(goal,1,160) AS goal FROM tasks'),
      runs: this.store.all('SELECT id,task_id,role,status,started_at,ended_at FROM agent_runs'),
    });
  },

  usage(taskId) {
    this.store.task(taskId);
    return readUsage(this.config, taskId);
  }
};
