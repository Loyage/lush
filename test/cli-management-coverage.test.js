import { test, expect } from 'bun:test';
import { CLI_COMMANDS, managementCLICommandPolicy } from '../src/cli/catalog.js';
import { runManagementCLI } from '../src/agent/management-cli.js';
import { managementPermissionMethods, validateManagementCall, managementAuthorization } from '../src/rpc/management-policy.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const registration = { command: { name:'fixture',command:'true' }, hook:{ name:'fixture',trigger:'worker.merge_received',mode:'persistent',enabled:true },
  expected_revisions:{ commands:'REV',registry:'REV' },client_request_id:'coverage-registration' };
const inline = { 'hook.json':{ template_id:uuid,template_version:1 },'template.json':{},'automation.json':registration,
  'command.json':{ name:'fixture',kind:'shell',command:'true' },'source.json':{ template_id:uuid },'signal.json':{} };
const env = { LUSH_PROJECT:'/never-discover-cli-coverage',LUSH_HOME:'/never-discover-cli-coverage/.lush',LUSH_TASK_ID:'5',LUSH_AGENT_TOKEN:'test-only-cli-probe',
  LUSH_MANAGER_RPC_SOCKET:'/never-discover-cli-coverage/.lush/rpc.sock',LUSH_RUNTIME_CONTEXT:JSON.stringify({ task_id:5,run_id:1,role:'manager',task_kind:'management',management_occurrence_id:1 }) };
function example(entry, method) {
  const argv = [...entry.example.matchAll(/'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2]).slice(1)
    .map(value => ({ COMMAND_ID:uuid,CONNECTION_ID:uuid,HOOK_ID:uuid,TEMPLATE_ID:uuid,SIGNAL_ID:uuid,UUID:uuid,PACKAGE_ID:'pkg-0123456789abcdef',COMMIT:'a'.repeat(40) }[value] ?? value));
  const file = argv.indexOf('--file');
  if (file !== -1) {
    if (!Object.hasOwn(inline,argv[file+1])) throw Error('missing safe inline fixture');
    argv.splice(file,2,'--data',JSON.stringify(inline[argv[file+1]]));
  }
  if (method === 'draft.add' && entry.path === 'order') argv.push('--buffer');
  if ((managementAuthorization(method) || method === 'system.settings') && !argv.includes('--scope')) argv.push('--scope','device');
  return argv;
}

// Unlike a catalogue-reference test, every supported method must have a path
// through the real fixed CLI admission AND its actual handler. The recording
// boundary checks current policy, then stops before dispatch; it never touches
// files, services, credentials or package code. Real execution is separately
// exercised by management-cli.test.js, including rename/package confirmation.
test('every effective capability has a policy-admissible real management CLI handler route', async () => {
  const methods = managementPermissionMethods().filter(item => item.access !== 'unavailable');
  const snapshot = { permissions:Object.fromEntries(managementPermissionMethods().map(item => [item.method,item.access])) };
  const failures = [], covered = new Set();
  for (const { method } of methods) {
    if (method === 'manager.catalog') continue; // Deliberately replaced by offline help, retained only for internal compatibility.
    const candidates = CLI_COMMANDS.filter(entry => !entry.directory && entry.rpc.includes(method) && managementCLICommandPolicy(entry).available);
    const attempts = [];
    for (const entry of candidates) {
      let reached = false;
      try {
        await runManagementCLI(example(entry,method),'coverage-probe',env,async (transport,body) => {
          expect(transport).toBe('manager.call'); expect(body.cli_command).toBe(entry.path);
          validateManagementCall(body.method,body.params,'明确管理设备全局范围',snapshot);
          if (body.method === method) { reached = true; throw Error('stop at trusted dispatch boundary'); }
          if (body.method === 'worker.lookup') return { status:'succeeded',result:{ id:5,worker_number:body.params.number } };
          throw Error('unsupported preparatory response; add an explicit safe fixture if required');
        });
      } catch (error) { attempts.push({ command:entry.path,error:error.message }); }
      if (reached) { covered.add(method); break; }
    }
    if (!covered.has(method)) failures.push({ method,candidates:attempts });
  }
  expect(failures).toEqual([]);
  expect(covered.size).toBe(methods.length-1);
});
