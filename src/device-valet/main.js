import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, LushError } from '../core/types.js';
import { DeviceValetService } from './service.js';
import { DeviceValetClient } from './client.js';
import { deviceValetHome,ensurePrivateDirectory,assertPrivateFile } from './paths.js';
import { createDeviceValetRunner } from './runner.js';

export async function serveDeviceValet({env=process.env,home=deviceValetHome(env),runner=null,signals=true,...options}={}){
  const service=new DeviceValetService({env,home,runner:runner??createDeviceValetRunner({env,home}),...options});let release;
  const closed=new Promise(resolve=>{release=resolve;});
  const stop=()=>{service.close().catch(()=>{process.exitCode=1;});};
  service.onClosed=()=>{if(signals){process.off('SIGTERM',stop);process.off('SIGINT',stop);}release();};
  if(signals){process.once('SIGTERM',stop);process.once('SIGINT',stop);}
  try{await service.start();}catch(error){if(signals){process.off('SIGTERM',stop);process.off('SIGINT',stop);}await service.close();throw error;}
  return {service,closed};
}

/** Only an authenticated, password-verified user submission may request startup. */
export async function startDeviceValet({env=process.env,home=deviceValetHome(env),timeoutMs=5000}={}){
  const client=new DeviceValetClient({env,home});client.assertUserControl();const current=await client.readStatus();if(current.online)return current;
  check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'invalid device Valet startup timeout');
  ensurePrivateDirectory(home);const logFile=path.join(home,'service.log');assertPrivateFile(logFile,{missing:true});const log=fs.openSync(logFile,'a',0o600);
  const childEnv={...env,LUSH_DEVICE_VALET_HOME:home};
  for(const key of Object.keys(childEnv))if(['LUSH_PROJECT','LUSH_HOME','LUSH_TASK_ID','LUSH_AGENT_TOKEN','LUSH_RUNTIME_CONTEXT','LUSH_ADMINISTRATOR_TOKEN','LUSH_ADMINISTRATOR_SOCKET'].includes(key)||key.startsWith('LUSH_MANAGER_')||key.startsWith('LUSH_ADMIN_')||key==='LUSH_DEVICE_VALET_TOKEN'||key==='LUSH_DEVICE_VALET_SOCKET'||key==='LUSH_DEVICE_VALET_BUN')delete childEnv[key];
  let launchError=false;
  try{const child=cp.spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:childEnv,detached:true,stdio:['ignore',log,log]});child.once('error',()=>{launchError=true;});child.unref();}finally{fs.closeSync(log);}
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(launchError)throw new LushError('设备管家服务启动失败；请核对私有日志，不自动重放。',-32071);const state=await client.readStatus();if(state.online)return state;await Bun.sleep(30);}
  throw new LushError('设备管家服务启动结果未确认；核对状态与原请求收据，不自动重复启动或提交。',-32071);
}
if(import.meta.main){try{const running=await serveDeviceValet({home:process.env.LUSH_DEVICE_VALET_HOME||deviceValetHome()});await running.closed;}catch{console.error('设备管家服务未确认启动或收口；请核对状态与私有日志，不自动重放。');process.exitCode=1;}}
