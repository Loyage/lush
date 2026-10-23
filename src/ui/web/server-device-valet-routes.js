import { check, isPlainObject } from '../../core/types.js';
import { userBody, userQuery } from './server-query.js';
import { DEVICE_VALET_API, DEVICE_VALET_ROUTES, normalizeDeviceValetDefinition, deviceValetIdentifier, DEVICE_VALET_LIMITS } from '../../device-valet/protocol.js';

function page(query,detail=false){
  const result={};
  if(detail){check(deviceValetIdentifier(query.id),'device Valet identity required');result.id=query.id;}
  if(query.before!==undefined){check(/^[1-9]\d*$/.test(query.before)&&Number.isSafeInteger(Number(query.before)),'invalid device Valet cursor');result.before=query.before;}
  if(query.limit!==undefined){check(/^[1-9]\d*$/.test(query.limit)&&Number(query.limit)<=DEVICE_VALET_LIMITS.maxPage,'device Valet limit must be 1..100');result.limit=Number(query.limit);}
  return result;
}
/** Root-only password entrance; no Agent, project override, generic RPC or raw secret forwarding. */
export function createDeviceValetHostRoutes(control){
  check(typeof control==='function','trusted device Valet control adapter required');
  return async context=>{
    const {request,url,json,user}=context;
    if(/^\/p\/[a-z0-9]{16}\/api\/host\/device-valet(?:\/|$)/.test(url.pathname))return json({error:'not found'},404);
    if(url.pathname!==DEVICE_VALET_API&&!url.pathname.startsWith(DEVICE_VALET_API+'/'))return null;
    check(user?.kind==='user_session'&&typeof user.sessionBinding==='string'&&/^[a-f0-9]{64}$/.test(user.sessionBinding),'device Valet requires a logged-in user');
    check(!request.headers.has('authorization')&&!request.headers.has('x-lush-agent-token'),'Agent credentials cannot authorize device Valet entrances');
    const action=url.pathname.slice(DEVICE_VALET_API.length+1);
    const invoke=(operation,params={})=>control(operation,params,{userBinding:user.sessionBinding});
    if(request.method==='GET'){
      if([DEVICE_VALET_ROUTES.options,DEVICE_VALET_ROUTES.status].includes(action)){userQuery(url,[]);return json(await invoke(action));}
      if(action===DEVICE_VALET_ROUTES.list)return json(await invoke('list',page(userQuery(url,['before','limit']))));
      if(action===DEVICE_VALET_ROUTES.detail)return json(await invoke('detail',page(userQuery(url,['id','before','limit']),true)));
      if(action===DEVICE_VALET_ROUTES.receipt){const query=userQuery(url,['client_request_id']);check(deviceValetIdentifier(query.client_request_id),'device Valet request identity required');return json(await invoke('receipt',query));}
    }
    if(request.method==='POST'){
      if(action===DEVICE_VALET_ROUTES.submit){
        check(!url.search&&request.headers.get('content-type')?.split(';')[0]==='application/json','device Valet requires JSON without query parameters');
        let body;try{body=await request.json();}catch{throw new Error('invalid device Valet JSON');}
        check(isPlainObject(body)&&Object.keys(body).sort().join(',')==='confirm,definition,password'&&body.confirm===true,'exact device Valet confirmation required');
        const definition=normalizeDeviceValetDefinition(body.definition);
        check(typeof context.verifyElevationPassword==='function','trusted password verifier required');let password=body.password;delete body.password;let verified;
        try{verified=await context.verifyElevationPassword(password);}finally{password='';}
        if(verified?.ok!==true)return json({error:verified?.error||'设备管家密码验证未通过；未提交执行。',code:verified?.code==='elevation_password_rate_limited'?'elevation_password_rate_limited':'elevation_password_rejected',execution:'not_started'},[401,403,429].includes(verified?.status)?verified.status:403);
        return json(await invoke('submit',{definition}));
      }
      if(action===DEVICE_VALET_ROUTES.stop){const body=await userBody(request,url);check(isPlainObject(body)&&Object.keys(body).join(',')==='id'&&deviceValetIdentifier(body.id),'device Valet stop requires an exact identity');return json(await invoke('stop',{id:body.id}));}
    }
    return json({error:'not found'},404);
  };
}
