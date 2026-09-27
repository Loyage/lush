import { readTranscript, readTranscriptLatest, readUsage } from '../transcript.js';
import { readUsageStatistics } from '../usage-statistics.js';
import { searchTranscript, transcriptStep, transcriptPage } from '../transcript-reader.js';

/** pi 会话记录的只读投影。 */
export default {
  /** Read-only agent process log from pi's session files; never touches the database. */
  transcript(apId, after = 0, limit = 100) {
    this.store.ap(apId);
    return readTranscript(this.config, apId, after, limit);
  },

  transcriptLatest(apId, after = 0, before = 0, limit = 100) {
    this.store.ap(apId);
    return readTranscriptLatest(this.config, apId, { after, before, limit });
  },

  transcriptPage(apId, seq, offset) { this.store.ap(apId); return transcriptPage(this.config, apId, seq, offset); },
  searchTranscript(apId, options) { this.store.ap(apId); return searchTranscript(this.config, apId, options); },
  transcriptStep(apId, seq, offset) { this.store.ap(apId); return transcriptStep(this.config, apId, seq, offset); },

  /** Read-only agent usage (model, context, cost) from the same session files, without the bodies. */
  usageStatistics(options) {
    return readUsageStatistics(this.config, options, {
      aps: this.store.all('SELECT id,role,status,integration,substr(goal,1,160) AS goal FROM aps'),
      runs: this.store.all('SELECT id,ap_id,role,status,started_at,ended_at FROM agent_runs'),
    });
  },

  usage(apId) {
    this.store.ap(apId);
    return readUsage(this.config, apId);
  }
};
