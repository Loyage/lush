import { check, isPlainObject } from '../core/types.js';
import { normalizeDeviceValetTool, DEVICE_VALET_LIMITS } from './protocol.js';
import { PARAMS, assertAllowed } from '../rpc/registry.js';
import { administratorSafeText } from '../administrator/delegation.js';

export const canonical = value => Array.isArray(value) ? value.map(canonical) : isPlainObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
export const encoded = value => JSON.stringify(canonical(value));
export function strictFields(value,allowed,required=[]) { check(isPlainObject(value) && Object.keys(value).every(k=>allowed.includes(k)) && required.every(k=>Object.hasOwn(value,k)),'invalid device Valet request fields'); }
export function userBinding(value) { check(typeof value==='string' && /^[a-f0-9]{64}$/.test(value),'authenticated device Valet user required'); }
export function validateResourceCall(value) {
  const tool=normalizeDeviceValetTool(value);
  if(tool.operation==='catalog') return tool;
  const blocked = /(?:^|[_-])(?:token|secret|password|credential|private[_-]key|api[_-]?key|authorization|cookie|env|prompt)(?:$|[_-])/i;
  const visit=(item,depth=0)=>{
    check(depth<20,'device Valet parameter nesting limit');
    if(!item||typeof item!=='object') return;
    for(const [key,child] of Object.entries(item)) {
      check(!blocked.test(key) && !/prompt/i.test(key) && !/^(?:accessToken|refreshToken|apiKey|agentToken|agent_token_hash|retry_profile|extensions|skills)$/i.test(key),'private or executable device Valet parameters prohibited');
      visit(child,depth+1);
    }
  };
  visit(tool.params);
  check(Buffer.byteLength(encoded(tool.params)) <= DEVICE_VALET_LIMITS.parametersBytes,'device Valet parameters exceed limit');
  assertAllowed(tool.method,{...tool.params,...(PARAMS[tool.method].includes('scope')?{scope:'device'}:{})},null);
  return tool;
}
export function safeText(value,secrets=[]) {
  let text=administratorSafeText(value);
  for(const secret of secrets) if(typeof secret==='string' && secret.length>=8) text=text.replaceAll(secret,'[redacted]');
  return text;
}
export function safeResult(value,limits={},depth=0) {
  if(depth>20) { limits.truncated=true; return null; }
  if(typeof value==='string') { if(value.length>8000) limits.truncated=true; return safeText(value).slice(0,8000); }
  if(value===null||typeof value==='number'||typeof value==='boolean') return value;
  if(Array.isArray(value)) { if(value.length>100) limits.truncated=true; return value.slice(0,100).map(v=>safeResult(v,limits,depth+1)); }
  if(!isPlainObject(value)) return null;
  const blocked = /(?:^|[_-])(?:token|secret|password|credential|private[_-]key|api[_-]?key|authorization|cookie|env|prompt)(?:$|[_-])/i;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!blocked.test(key)&&!/prompt/i.test(key)&&!['raw','session','session_path','retry_profile','agent_config','configuration_scope','device_home','project_home'].includes(key)
    && !/^(?:systemPrompt|accessToken|refreshToken|apiKey|privatePrompt|agentToken)$/i.test(key)).map(([key,item])=>[key,safeResult(item,limits,depth+1)]));
}
export const SAFE_FAILURE = '设备管家执行未确认完成；保留原收据，副作用可能未知，不自动重放。';
