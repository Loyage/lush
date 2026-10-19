/** Pure Node/Bun protocol. No project discovery, settings or executable lookup. */
import { managementCLICommandPolicy } from '../cli/catalog.js';
const CLI_PARSE_ERROR = 'CLI 参数无效或入口不可用；本次命令未执行。请用 lush_cli help 核对真实用法，禁止文件、跨项目或本地服务工作流。';
export function managementCLIParseError() {
  return Object.assign(new Error(CLI_PARSE_ERROR), { kind: 'invalid_parameters', execution: 'not_started', recovery: 'read_catalog' });
}
export function safeManagementCLIError(value) {
  return (value?.error ?? value?.message) === CLI_PARSE_ERROR && value?.kind === 'invalid_parameters' && value?.execution === 'not_started'
    ? { error: CLI_PARSE_ERROR, kind: 'invalid_parameters', execution: 'not_started', recovery: 'read_catalog' } : null;
}
export function validateManagementCLI(argv, requestId) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 128 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(argv)) > 40000
    || typeof requestId !== 'string' || !requestId || requestId.length > 128 || /[\x00-\x1f\x7f]/.test(requestId))
    throw managementCLIParseError();
  // Reject even for help: no alternate project, local file, credentials or process controls.
  const separator = argv.indexOf('--'), options = argv.slice(0, separator < 0 ? argv.length : separator);
  if (options.some(arg => /^--(?:project|file|profile-file|questions-file|answers-file|url-file|foreground|runner-node)(?:=|$)/.test(arg)))
    throw managementCLIParseError();
}

// Reviewed handler-local effects, not a second command/RPC catalogue. Everything
// else still goes through the latest daemon policy, registration and actor checks.
export function assertManagementCLICommand(entry) {
  if (!managementCLICommandPolicy(entry).available)
    throw new Error('CLI command has unreviewed local effects');
}
