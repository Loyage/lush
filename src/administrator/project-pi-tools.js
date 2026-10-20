import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ADMINISTRATOR_TOOL_NAMES, PROJECT_ADMINISTRATOR_SCHEMA, PROJECT_ADMINISTRATOR_PROMPT, validateProjectAdministratorTool } from './project-tool-protocol.js';
const BRIDGE = fileURLToPath(new URL('./project-tool-bridge.js',import.meta.url));
export async function projectAdministratorRequest(value, _toolCallId, signal, env = process.env) {
  validateProjectAdministratorTool(value);
  if (!path.isAbsolute(env.LUSH_MANAGER_BUN || '') || signal?.aborted) throw new Error('project administrator bridge unavailable');
  const allowed = ['PATH','LUSH_PROJECT','LUSH_HOME','LUSH_TASK_ID','LUSH_AGENT_TOKEN','LUSH_RUNTIME_CONTEXT','LUSH_MANAGER_RPC_SOCKET'];
  const child = cp.spawn(env.LUSH_MANAGER_BUN,[BRIDGE],{stdio:['pipe','pipe','ignore'],env:Object.fromEntries(allowed.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]))});
  const closed = new Promise(resolve=>child.once('close',resolve));
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  let timer,output='';
  try {
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;error?reject(error):resolve(result);};
      timer=setTimeout(()=>{kill();finish(new Error('项目管理员工具超时；副作用未知，不重放。'));},30000);
      signal?.addEventListener('abort',kill,{once:true});
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>128000){kill();finish(new Error('项目管理员工具输出超限；不重放。'));}});
      child.on('error',()=>finish(new Error('项目管理员 bridge 启动失败。')));
      child.stdin.on('error',()=>finish(new Error('项目管理员传输中断；不重放。')));
      child.on('close',code=>{
        if(signal?.aborted){finish(new Error('项目管理员输入已停止；核对原始收据。'));return;}
        try{const result=JSON.parse(output);if(code!==0||result.ok!==true)throw new Error();finish(null,result.result);}
        catch{finish(new Error('项目管理员结果未确认；检查原始收据，不重放。'));}
      });
      child.stdin.end(JSON.stringify(value));if(signal?.aborted)kill();
    });
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',kill);kill();await closed;}
}
export function registerProjectAdministratorTools(pi, request = projectAdministratorRequest, env = process.env) {
  const bound={...env};
  pi.registerTool({name:PROJECT_ADMINISTRATOR_TOOL_NAMES[0],label:'当前项目管理员',exposure:'model-only',
    description:'仅本条已验密的当前项目管理员工具。先catalog；project.call仅接受method/params，不接受项目或设备覆盖。源码读取见source.list/read。未知结果只读核对，不重放。',
    parameters:PROJECT_ADMINISTRATOR_SCHEMA,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
    async execute(toolCallId,params,signal){validateProjectAdministratorTool(params);const result=await request(params,toolCallId,signal,bound);return{content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const restrict=()=>pi.setActiveTools([...PROJECT_ADMINISTRATOR_TOOL_NAMES]);
  pi.on('session_start',restrict);pi.on('before_agent_start',()=>{restrict();return{systemPrompt:PROJECT_ADMINISTRATOR_PROMPT};});
  pi.on('tool_call',event=>PROJECT_ADMINISTRATOR_TOOL_NAMES.includes(event.toolName)?undefined:{block:true,reason:'本条项目提权只允许专用管理员工具。'});
}
export default function projectAdministratorTools(pi){registerProjectAdministratorTools(pi);}
