import { check } from '../core/types.js';
import { DeviceSettingsService } from './device-settings.js';
import { DeviceValetClient } from '../device-valet/client.js';
import { startDeviceValet } from '../device-valet/main.js';
import { normalizeDeviceValetProfile } from '../device-valet/protocol.js';
import { safeResult } from '../device-valet/safety.js';

/** Host adapter owns only public selection reads and authenticated transport, not Workers. */
export function deviceValetControl(env,{client=null,startService=null,settingsService=null}={}){
  let connection=client,settings=settingsService;
  const get=()=>connection??=new DeviceValetClient({env,startService:startService??(()=>startDeviceValet({env}))});
  const getSettings=()=>settings??=new DeviceSettingsService(env);
  const control=async(operation,params,{userBinding}={})=>{
    if(operation==='options'){
      const source=getSettings();let profile=null;
      try{const manager=source.agents.resolve('manager');profile=normalizeDeviceValetProfile({agent:manager.agent,config_mode:manager.config_mode??'lush',connection_id:manager.connection_id,model:manager.model,thinking:manager.thinking});}catch{/* Explicit model selection remains required when the default is not managed. */}
      const [choices,registered]=await Promise.all([source.request('agent.selection.resources'),source.request('agent.registered_models.list')]);
      const limits={},connections=safeResult(choices.connections??[],limits),registered_models=safeResult(registered.models??[],limits);
      return {version:1,default_profile:profile,connections,registered_models,
        ...(limits.truncated?{truncated:true,coverage:'bounded_device_resource_options'}:{})};
    }
    const service=get();
    switch(operation){case 'status':return service.readStatus();case 'list':return service.list(params);case 'detail':return service.detail(params);case 'submit':check(userBinding,'password-verified user binding required');return service.submit(params.definition,userBinding);case 'receipt':return service.receipt(params,userBinding);case 'stop':return service.stop(params.id,userBinding);default:throw new Error('unknown device Valet control operation');}
  };
  control.close=()=>settings?.stop();return control;
}
