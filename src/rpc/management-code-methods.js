// Reviewed management bridge capabilities, independent of the ordinary Worker
// CLI surface. These operations preserve real Valet identity and cross-tree
// authority through durable management receipts; context.* is never proxied.
export const MANAGEMENT_CODE_READS = new Set([
  'system.status','worker.lookup','worker.list','worker.tree','worker.inspect',
  'worker.transcript','worker.history','branch.tree','branch.show','notice.list',
]);
export const MANAGEMENT_CODE_METHODS = new Set([
  ...MANAGEMENT_CODE_READS, 'worker.spawn','worker.auto_title','worker.message',
  'worker.accept','notice.post','progress.plan','progress.complete',
]);
