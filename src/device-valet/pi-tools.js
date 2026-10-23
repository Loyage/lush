import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE_VALET_TOOL_NAMES, DEVICE_VALET_TOOL_SCHEMA, DEVICE_VALET_SYSTEM_PROMPT, normalizeDeviceValetTool } from './tool-protocol.js';

const BRIDGE=fileURLToPath(new URL('./tool-bridge.js',import.meta.url));
export async function deviceValetToolRequest(value,_toolCallId,signal,env=process.env,{timeoutMs=30000}={}){
  const tool=normalizeDeviceValetTool(value);
  if(!path.isAbsolute(env.LUSH_DEVICE_VALET_BUN||'')||!path.isAbsolute(env.LUSH_DEVICE_VALET_SOCKET||'')||!env.LUSH_DEVICE_VALET_TOKEN||signal?.aborted)throw new Error('device Valet invocation unavailable');
  const child=cp.spawn(env.LUSH_DEVICE_VALET_BUN,[BRIDGE],{stdio:['pipe','pipe','ignore'],env:{PATH:env.PATH||'',LUSH_DEVICE_VALET_SOCKET:env.LUSH_DEVICE_VALET_SOCKET,LUSH_DEVICE_VALET_TOKEN:env.LUSH_DEVICE_VALET_TOKEN}});
  const closed=new Promise(resolve=>child.once('close',resolve));let output='',timer;
  const kill=()=>{try{child.kill('SIGKILL');}catch{}};
  try{return await new Promise((resolve,reject)=>{
    let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;error?reject(error):resolve(result);};
    timer=setTimeout(()=>{kill();finish(new Error('device Valet tool timed out; inspect original receipt, do not replay'));},timeoutMs);
    signal?.addEventListener('abort',kill,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>512*1024){kill();finish(new Error('device Valet output limit; effect unknown'));}});
    child.on('error',()=>finish(new Error('device Valet bridge unavailable')));child.stdin.on('error',()=>finish(new Error('device Valet bridge transport unconfirmed')));
    child.on('close',code=>{if(signal?.aborted){finish(new Error('device Valet stopped; effect unknown'));return;}try{const response=JSON.parse(output);if(code!==0||response?.ok!==true){finish(new Error('device Valet tool refused or unconfirmed; inspect receipt, do not replay'));return;}finish(null,response.result);}catch{finish(new Error('device Valet tool response unconfirmed; do not replay'));}});
    child.stdin.end(JSON.stringify(tool));if(signal?.aborted)kill();
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',kill);kill();await closed;}
}
export function registerDeviceValetTools(pi,request=deviceValetToolRequest,env=process.env){
  const bound={PATH:env.PATH,LUSH_DEVICE_VALET_BUN:env.LUSH_DEVICE_VALET_BUN,LUSH_DEVICE_VALET_SOCKET:env.LUSH_DEVICE_VALET_SOCKET,LUSH_DEVICE_VALET_TOKEN:env.LUSH_DEVICE_VALET_TOKEN};
  pi.registerTool({name:DEVICE_VALET_TOOL_NAMES[0],label:'设备资源管家',exposure:'model-only',description:'本条密码授权的设备资源能力。先 catalog，再 call(method,params)。无文件、Shell、凭证、项目调度或新授权入口；联网刷新为写，unknown 不重放。',parameters:DEVICE_VALET_TOOL_SCHEMA,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
    async execute(id,params,signal){const result=await request(normalizeDeviceValetTool(params),id,signal,bound);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const restrict=()=>pi.setActiveTools([...DEVICE_VALET_TOOL_NAMES]);pi.on('session_start',restrict);pi.on('before_agent_start',()=>{restrict();return {systemPrompt:DEVICE_VALET_SYSTEM_PROMPT};});
  pi.on('tool_call',event=>DEVICE_VALET_TOOL_NAMES.includes(event.toolName)?undefined:{block:true,reason:'设备管家仅允许受信设备资源工具，不开放文件、Shell或其他工具。'});
}
export default function deviceValetTools(pi){registerDeviceValetTools(pi);}
