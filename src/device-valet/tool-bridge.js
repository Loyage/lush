import { RPCClient } from '../rpc/client.js';
import { normalizeDeviceValetTool, DEVICE_VALET_RPC } from './protocol.js';

/** Fixed Bun transport. Never reads control credentials or accepts a model request identity. */
export async function requestDeviceValetTool(value,env=process.env,request=null){
  const tool=normalizeDeviceValetTool(value);
  if(typeof env.LUSH_DEVICE_VALET_SOCKET!=='string'||!env.LUSH_DEVICE_VALET_SOCKET.startsWith('/')||typeof env.LUSH_DEVICE_VALET_TOKEN!=='string'||env.LUSH_DEVICE_VALET_TOKEN.length<32)throw new Error('device Valet invocation required');
  const method=tool.operation==='catalog'?DEVICE_VALET_RPC.catalog:DEVICE_VALET_RPC.call;
  const params={token:env.LUSH_DEVICE_VALET_TOKEN,...(tool.operation==='call'?{tool}:{})};
  return request?request(method,params):new RPCClient(env.LUSH_DEVICE_VALET_SOCKET,30).request(method,params);
}
if(import.meta.main){
  try{const text=await Bun.stdin.text();if(Buffer.byteLength(text)>131072)throw new Error('input limit');const result=await requestDeviceValetTool(JSON.parse(text));const reply=JSON.stringify({ok:true,result});if(Buffer.byteLength(reply)>512*1024)throw new Error('output limit');process.stdout.write(reply);}
  catch{process.stdout.write(JSON.stringify({ok:false,error:'device Valet result unconfirmed; inspect durable receipt, do not replay'}));process.exitCode=1;}
}
