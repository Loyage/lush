import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { digest, iso, resource, observation } from './agent-connection-fixture.js';
import { normalizeConnectionObservation } from '../../src/persistence/store/agent-connections.js';

const record = (extra = {}) => ({ query_key:'query-one', connection_id:'conn-one', revision:'fixture-revision', provider:'deepseek',
  account_key:digest('account-one'),source_key:digest('source-one'),observation:observation(),...extra });
const history = (f,extra = {}) => f.store.readAgentConnectionHistory({id:'conn-one',from:iso(-86400000),to:iso(0),retention_days:90,...extra});

test('Store separates connection/account/source/kind/scope/unit/window and preserves real zero/null', async () => {
  const f=fixture();
  try {
    expect(f.store.recordAgentConnectionObservation(record())).toBe(true);
    expect(f.store.recordAgentConnectionObservation(record())).toBe(false);
    f.store.recordAgentConnectionObservation(record({query_key:'zero',observation:observation({checked_at:iso(-500),resources:[resource(0,{total:null,used:null})]})}));
    f.store.recordAgentConnectionObservation(record({query_key:'account',account_key:digest('account-two')}));
    f.store.recordAgentConnectionObservation(record({query_key:'source',source_key:digest('source-two')}));
    f.store.recordAgentConnectionObservation(record({query_key:'kind',observation:observation({resources:[resource(7,{kind:'balance',unit:'USD',window_seconds:null})]})}));
    f.store.recordAgentConnectionObservation(record({query_key:'scope',observation:observation({resources:[resource(7,{scope:'model',models:['gpt-small']})]})}));
    f.store.recordAgentConnectionObservation(record({query_key:'unit',observation:observation({resources:[resource(7,{unit:'请求'})]})}));
    f.store.recordAgentConnectionObservation(record({query_key:'window',observation:observation({resources:[resource(7,{window_seconds:604800})]})}));
    f.store.recordAgentConnectionObservation(record({query_key:'other-connection',connection_id:'conn-two'}));
    const result=history(f); expect(result.series).toHaveLength(7);
    const zero=result.series.find(item=>item.scope==='account'&&item.kind==='quota'&&item.unit==='%'&&item.window_seconds===18000&&item.account_key===digest('account-one')&&item.source_key===digest('source-one'));
    expect(zero.points.find(point=>point.at===iso(-500)).remaining).toBe(0);
    expect(zero.points.find(point=>point.at===iso(-500)).total).toBeNull();
    expect(zero.points.find(point=>point.at===iso(-500)).used).toBeNull();
    expect(result.series.every(item=>item.connection_id==='conn-one')).toBe(true);
    expect(f.store.lastAgentConnectionSuccess('conn-one',digest('account-one'),digest('source-one')).observation.checked_at).toBe(iso(-500));
  } finally {await f.close();}
});

test('Store projects safe finite data; raw errors/credentials are excluded and partial metrics are independently usable', async () => {
  const f=fixture();
  try {
    f.store.recordAgentConnectionObservation(record({observation:observation({resources:[resource(70,{token:'SECRET',remaining:Infinity,used_percent:120})],
      reason:'SECRET raw text',access_token:'SECRET'})}));
    const row=f.store.get('SELECT payload FROM agent_connection_queries');
    expect(row.payload).not.toContain('SECRET'); expect(row.payload).not.toContain('token');
    const safe=JSON.parse(row.payload); expect(safe.resources[0].remaining).toBeNull(); expect(safe.resources[0].used_percent).toBeNull();
    f.store.recordAgentConnectionObservation(record({query_key:'partial',observation:observation({status:'partial',resources:[resource(60)],error_code:'unauthorized'})}));
    expect(history(f).series[0].points.find(point=>point.remaining===60).status).toBe('available');
    const failed=normalizeConnectionObservation({status:'error',checked_at:iso(0),source:'usage_api',error_code:'SECRET error',resources:[resource()],raw:'SECRET'});
    expect(failed.error_code).toBe('unknown'); expect(failed.resources[0].remaining).toBeNull(); expect(JSON.stringify(failed)).not.toContain('SECRET');
    expect(normalizeConnectionObservation({status:'available',resources:[]})).toMatchObject({status:'unknown',error_code:'invalid_response'});
    expect(()=>f.store.recordAgentConnectionObservation(record({account_key:'SECRET api key'}))).toThrow('identity');
  } finally {await f.close();}
});

test('revision heads cannot show an earlier account/config after invalidation or a source mismatch', async () => {
  const f=fixture();
  try {
    const old=f.store.ensureAgentConnectionState('conn-one',digest('config'));
    f.store.rememberAgentConnectionIdentity('conn-one',old.revision,digest('account-one'),digest('source-one'));
    f.store.recordAgentConnectionObservation(record({revision:old.revision}));
    expect(f.store.latestAgentConnectionObservation('conn-one',old.revision,digest('account-one'),digest('source-one')).status).toBe('available');
    const next=f.store.ensureAgentConnectionState('conn-one',digest('config'),true);
    expect(next.revision).not.toBe(old.revision); expect(next.account_key).toBeNull();
    f.store.rememberAgentConnectionIdentity('conn-one',old.revision,digest('account-one'),digest('source-one'));
    expect(f.store.agentConnectionState('conn-one').account_key).toBeNull();
    expect(f.store.latestAgentConnectionObservation('conn-one',next.revision,digest('account-one'),digest('source-one'))).toBeNull();
    expect(f.store.latestAgentConnectionObservation('conn-one',old.revision,digest('account-one'),digest('wrong-source'))).toBeNull();
    f.store.forgetAgentConnectionState('conn-one'); expect(history(f).series).toHaveLength(1);
  } finally {await f.close();}
});

test('retention only prunes managed connection cache, keeping legacy observations and task facts intact', async () => {
  const f=fixture();
  try {
    f.store.recordAgentConnectionObservation(record({observation:observation({checked_at:iso(-2*86400000)})}));
    f.store.recordAgentConnectionObservation(record({query_key:'new'}));
    f.store.recordAgentUsage({query_key:'legacy',provider:'deepseek',account_key:'legacy',source_key:digest('old-source'),at:iso(-2*86400000),status:'available',kind:'balance',items:[{id:'cash',remaining:10}]});
    expect(f.store.pruneAgentConnections(iso(-86400000))).toBe(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n).toBe(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(1);
    expect(f.store.get('SELECT COUNT(*) AS n FROM tasks').n).toBe(0);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_connection_points').n).toBe(1);
  } finally {await f.close();}
});

test('history samples full span with failures, extremes and reset transitions, rather than newest rows', async () => {
  const f=fixture(),hour=3600000;
  try {
    f.store.transaction(()=>{
      for(let index=0;index<1800;index++)f.store.recordAgentConnectionObservation(record({query_key:`hour-${index}`,
        observation:observation({checked_at:iso((index-1800)*hour),...(index===400?{status:'error',resources:[],error_code:'timeout'}:{
          resources:[resource(index===340?-100:index===1390?200:50,{used_percent:null,reset_at:index<401?iso(hour):index<1200?iso(2*hour):iso(3*hour)})]})})}));
    });
    for(const days of [7,30,90]){
      const result=history(f,{from:iso(-days*24*hour)}),entry=result.series[0];
      expect(entry.sample_count).toBe(Math.min(days*24,1800)); expect(entry.points.length).toBeLessThanOrEqual(500);
      expect(entry.points[0].at).toBe(iso(-Math.min(days*24,1800)*hour)); expect(entry.points.at(-1).at).toBe(iso(-hour));
      expect(result.truncated).toBe(entry.sample_count>entry.points.length);
    }
    const all=history(f,{from:iso(-90*24*hour)}).series[0].points;
    expect(all.some(point=>point.remaining===-100)).toBe(true); expect(all.some(point=>point.remaining===200)).toBe(true);
    expect(all.some(point=>point.at===iso((400-1800)*hour)&&point.status==='error')).toBe(true);
    expect(all.some(point=>point.at===iso((401-1800)*hour)&&point.reset_at===iso(2*hour))).toBe(true);
    expect(all.some(point=>point.at===iso((1200-1800)*hour)&&point.reset_at===iso(3*hour))).toBe(true);
  } finally {await f.close();}
});

test('multi-series history remains below 680KB with 40 series and excessive metadata, exposing downsampling', async () => {
  const f=fixture();
  try {
    const resources=Array.from({length:20},(_,index)=>resource(50,{id:`metric-${index}`,label:'额度'.repeat(100),unit:'单位'.repeat(50),
      models:Array.from({length:50},(_,model)=>`model-${model}-${'长'.repeat(250)}`)}));
    f.store.transaction(()=>{
      for(let account=0;account<2;account++)for(let index=0;index<510;index++)f.store.recordAgentConnectionObservation(record({
        query_key:`large-${account}-${index}`,account_key:digest(`account-${account}`),observation:observation({checked_at:iso(-510000+index*1000),resources})}));
    });
    const result=history(f); expect(result.series).toHaveLength(40); expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(680000);
    for(const entry of result.series){expect(entry.sample_count).toBe(510);expect(entry.points.length).toBeLessThanOrEqual(500);
      expect(entry.points[0].at).toBe(iso(-510000));expect(entry.points.at(-1).at).toBe(iso(-1000));}
    f.store.recordAgentConnectionObservation(record({query_key:'overflow-series',account_key:digest('account-3')}));
    expect(history(f).truncated).toBe(true); expect(history(f).series).toHaveLength(40);
  } finally {await f.close();}
});
