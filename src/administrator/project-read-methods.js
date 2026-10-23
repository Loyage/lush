import { AGENT_RESOURCE_READ_METHODS } from '../core/agent-resource-policy.js';

// Reviewed handler facts shared by execution, recovery and receipt projection.
// Never infer read-only behavior from an exception's message/code or its result.
export const PROJECT_READS = new Set(['cli.catalog','system.status','system.summary','system.diagnostics','worker.lookup','worker.graph','worker.list','worker.activity','worker.page','worker.tree','worker.inspect',
  'worker.management_calls','worker.progress_history','worker.relations','worker.version_graph','worker.version_deliveries','worker.version_commit','worker.version_lineage','worker.version_lineage_commit',
  'worker.reading_page','worker.reading_record','worker.history','worker.history_page','worker.diff','worker.usage','worker.code_state','worker.code_tree','worker.code_file',
  'worker.transcript','worker.transcript_latest','worker.transcript_page','worker.transcript_step','worker.transcript_search','worker.runs_page','worker.artifacts_page','worker.artifact',
  'worker.hooks','worker.completion_page','worker.delivery_graph','worker.accept_preview','worker.delete_preview','worker.merge_conditions',
  'input.history','input.get','input.parents','notice.list','notice.page','notice.sync','branch.history','branch.version_graph','branch.tree','branch.show','graph.get',
  'hooks.list','hooks.command_export','hooks.command_history','branch.integrate_plan','branch.integration','branch.convergence','branch.convergence_list','branch.convergence_defaults','branch.convergence_runs',
  'management.receipt','management.emergency_preview', ...AGENT_RESOURCE_READ_METHODS]);
export const projectAdministratorReadOnly = call => call.authorization_mode === 'project_administrator'
  && (call.operation === 'project.call' ? PROJECT_READS.has(call.method) : ['catalog','source.list','source.read'].includes(call.operation));
