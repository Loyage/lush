import fs from 'node:fs';
import { check } from '../core/types.js';
import { RPCClient } from '../rpc/client.js';
import { DEVICE_VALET_RPC } from './protocol.js';
import { deviceValetHome,deviceValetPaths,assertPrivateDirectory,assertPrivateFile,readControlSecret } from './paths.js';

/** Host-side private control client. Never available in the model extension/bridge. */
export class DeviceValetClient {
  constructor({env=process.env,home=deviceValetHome(env),startService=null,timeout=30}={}){this.env=env;this.paths=deviceValetPaths(home);this.startService=startService;this.timeout=timeout;}
  assertUserControl(){check(!this.env.LUSH_AGENT_TOKEN&&!this.env.LUSH_ADMIN_TOKEN&&!this.env.LUSH_ADMINISTRATOR_TOKEN&&!this.env.LUSH_DEVICE_VALET_TOKEN,'Agent identities cannot authorize device Valet user control');}
  async request(method,params={}){
    this.assertUserControl();assertPrivateDirectory(this.paths.home);assertPrivateFile(this.paths.socket,{socket:true});
    return new RPCClient(this.paths.socket,this.timeout).request(method,{...params,control:readControlSecret(this.paths)});
  }
  async readStatus(){
    this.assertUserControl();if(!fs.existsSync(this.paths.home))return {version:1,online:false,active:0,coverage:'device_valet_offline_history_unread'};
    assertPrivateDirectory(this.paths.home);
    if(!assertPrivateFile(this.paths.socket,{missing:true,socket:true}))return {version:1,online:false,active:0,coverage:'device_valet_offline_history_unread'};
    try{return await this.request(DEVICE_VALET_RPC.status);}catch(error){if(error.code===-32004)return {version:1,online:false,active:0,coverage:'device_valet_offline_history_unread'};throw error;}
  }
  async list(options={}){if(!(await this.readStatus()).online)return {version:1,online:false,items:[],next_cursor:null,has_more:false,history_complete:false,coverage:'device_valet_offline_history_unread'};return this.request(DEVICE_VALET_RPC.list,{options});}
  detail(options){return this.request(DEVICE_VALET_RPC.detail,{options});}
  async submit(definition,userBinding){
    this.assertUserControl();if(!(await this.readStatus()).online){check(typeof this.startService==='function','device Valet is offline; explicit user submit required');await this.startService();}
    return this.request(DEVICE_VALET_RPC.submit,{definition,user_binding:userBinding});
  }
  async receipt(options,userBinding){if(!(await this.readStatus()).online)return {version:1,found:false,online:false,coverage:'device_valet_offline_history_unread'};return this.request(DEVICE_VALET_RPC.receipt,{options,user_binding:userBinding});}
  stop(id,userBinding){return this.request(DEVICE_VALET_RPC.stop,{id,user_binding:userBinding});}
  shutdown(userBinding){return this.request(DEVICE_VALET_RPC.shutdown,{user_binding:userBinding});}
}
