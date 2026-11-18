/* Read-only Codex rollout analysis. Contents/arguments are not included in reports. */
(function(root){
'use strict';
const num=x=>(typeof x==='number'||(typeof x==='string'&&x.trim()!==''))&&Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=Number.MAX_SAFE_INTEGER?Number(x):null;
const pick=(o,a,b)=>o?.[a]??o?.[b];
const txt=x=>typeof x==='string'?x.slice(0,300):null;
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?Date.parse(x):null;
const keys=['input','cached','output','reasoning','total'];
function usage(u){if(!u||typeof u!=='object')return null;
 const r={input:num(pick(u,'input_tokens','inputTokens')),cached:num(pick(u,'cached_input_tokens','cachedInputTokens')),output:num(pick(u,'output_tokens','outputTokens')),reasoning:num(pick(u,'reasoning_output_tokens','reasoningOutputTokens')),total:num(pick(u,'total_tokens','totalTokens'))};
 return keys.some(k=>r[k]!==null)?r:null;
}
function normalize(raw, source='import', index=0){
 if(!raw||typeof raw!=='object')return null;
 if(raw.kind&&raw.schema==='codex-observer-event/1'){
 const e={schema:raw.schema,source:txt(raw.source)||source,seq:num(raw.seq)??index,kind:txt(raw.kind)||'other'};
 for(const k of ['timestamp','sessionId','turnId','callId','tool','responseId','forkedFrom','version','project','model','status','eventType','eventId'])e[k]=txt(raw[k]);
 for(const k of ['durationMs','reportedDurationMs','reportedTtftMs','startedAt','completedAt','contextWindow'])e[k]=num(raw[k]);
 for(const k of ['usage','last','threadUsage'])if(raw[k]){e[k]={};for(const uk of keys)e[k][uk]=num(raw[k][uk]);}
 if(raw.rateLimits)e.rateLimits={primary:num(raw.rateLimits.primary),secondary:num(raw.rateLimits.secondary)};
 return e;
 }
 const p=raw.payload||{}, item=raw.params?.item||{};
 const e={schema:'codex-observer-event/1',source,seq:index,timestamp:txt(raw.timestamp),kind:'unknown',sessionId:null,turnId:txt(p.turn_id),callId:txt(p.call_id),tool:null};
 if(raw.method){
 const p2=raw.params||{};e.sessionId=txt(p2.threadId);e.turnId=txt(p2.turnId||p2.turn?.id);
 if(raw.method==='turn/started')e.kind='turn-start';
 else if(raw.method==='turn/completed'){e.kind='turn-end';e.status=txt(p2.turn?.status);e.reportedDurationMs=num(p2.turn?.durationMs);e.reportedTtftMs=num(p2.turn?.timeToFirstTokenMs);}
 else if(raw.method==='thread/tokenUsage/updated'){e.kind='usage-total';e.usage=usage(p2.tokenUsage?.total);e.last=usage(p2.tokenUsage?.last);}
 else if(raw.method==='item/agentMessage/delta')e.kind='output-delta';
 else if(['item/started','item/completed'].includes(raw.method)&&['commandExecution','mcpToolCall','dynamicToolCall'].includes(item.type)){e.kind=raw.method==='item/started'?'tool-start':'tool-end';e.callId=txt(item.id);e.tool=txt(item.tool||item.type);e.durationMs=num(item.durationMs);e.exitCode=item.exitCode??null;}
 else e.kind='other';return e;
 }
 if(raw.type==='session_meta'){e.kind='session';e.sessionId=txt(p.id);e.forkedFrom=txt(p.forked_from_id);e.version=txt(p.cli_version);e.project=txt(p.project_hash);}
 else if(raw.type==='turn_context'){e.kind='context';e.model=txt(p.model);}
 else if(raw.type==='token_usage_record'){e.kind='usage-record';e.sessionId=txt(p.thread_id);e.turnId=txt(p.turn_id);e.responseId=txt(p.response_id);e.usage=usage(p.usage);e.threadUsage=usage(p.thread_token_usage);}
 else if(raw.type==='event_msg'){
 switch(p.type){
 case 'task_started':case 'turn_started':e.kind='turn-start';break;
 case 'task_complete':case 'turn_complete':e.kind='turn-end';e.status=p.error?'failed':'completed';e.reportedDurationMs=num(p.duration_ms);e.reportedTtftMs=num(p.time_to_first_token_ms);e.startedAt=num(p.started_at);e.completedAt=num(p.completed_at);break;
 case 'turn_aborted':e.kind='turn-end';e.status='interrupted';break;
 case 'token_count':e.kind='usage-total';e.usage=usage(p.info?.total_token_usage);e.last=usage(p.info?.last_token_usage);e.contextWindow=num(p.info?.model_context_window);
 if(p.rate_limits)e.rateLimits={primary:num(p.rate_limits.primary?.used_percent),secondary:num(p.rate_limits.secondary?.used_percent)};break;
 case 'token_usage_record':e.kind='usage-record';e.responseId=txt(p.response_id);e.usage=usage(p.usage);break;
 case 'exec_command_begin':case 'mcp_tool_call_begin':case 'patch_apply_begin':e.kind='tool-start';e.tool=p.type==='exec_command_begin'?'command':p.type==='patch_apply_begin'?'apply_patch':txt(p.invocation?.tool)||'mcp';break;
 case 'exec_command_end':case 'mcp_tool_call_end':case 'patch_apply_end':e.kind='tool-end';e.exitCode=p.exit_code??null;e.success=p.success??null;e.durationMs=num(p.duration_ms)??(p.duration&&num(p.duration.secs)!==null?Number(p.duration.secs)*1000+Number(p.duration.nanos||0)/1e6:null);break;
 case 'agent_message':e.kind='agent-message';break;
 case 'agent_message_delta':e.kind='output-delta';break;
 case 'stream_error':case 'error':e.kind='error';break;
 case 'context_compacted':e.kind='compaction';break;
 case 'thread_settings_applied':e.kind='context';e.model=txt(p.thread_settings?.model);e.sessionId=txt(p.thread_id);break;
 default:e.kind='other';e.eventType=txt(p.type);}
 }else if(raw.type==='response_item'){
 if(['function_call','custom_tool_call'].includes(p.type)){e.kind='tool-start';e.tool=txt(p.name)||p.type;}
 else if(['function_call_output','custom_tool_call_output'].includes(p.type))e.kind='tool-end';
 else if(p.type==='message'&&p.role==='assistant')e.kind='agent-message';else e.kind='other';
 }else{e.kind='other';e.eventType=txt(raw.type);}
 return e;
}
function parseText(text,source='import'){
 const trimmed=text.trim();if(!trimmed)return {events:[],warnings:['Пустой файл'],capture:null};
 if(trimmed.startsWith('{')){try{const obj=JSON.parse(trimmed);if(obj.format==='codex-observer/1'){return {events:(obj.events||[]).map((x,i)=>normalize(x,x.source||source,i)),warnings:obj.notices||[],capture:obj};}}catch{}}
 const lines=text.split(/\r?\n/),events=[],warnings=[];
 for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;if(lines[i].length>2*1024*1024){warnings.push('Строка '+(i+1)+': превышен предел 2 МиБ');continue;}
 try{const e=normalize(JSON.parse(lines[i]),source,i);if(e)events.push(e);}catch{warnings.push('Строка '+(i+1)+': '+(i===lines.length-1?'неполный хвост JSONL':'невалидный JSON'));}}
 return {events,warnings,capture:null};
}
function sumUsage(list){const out={};for(const k of keys){const values=list.map(u=>u?.[k]).filter(x=>x!==null&&x!==undefined);out[k]=values.length?values.reduce((a,b)=>a+b,0):null;}return out;}
function unionMs(intervals,start,end){const arr=intervals.map(([a,b])=>[Math.max(a,start),Math.min(b,end)]).filter(([a,b])=>b>=a).sort((a,b)=>a[0]-b[0]);let result=0,lo=null,hi=null;for(const[a,b]of arr){if(lo===null){lo=a;hi=b;}else if(a<=hi)hi=Math.max(hi,b);else{result+=hi-lo;lo=a;hi=b;}}return result+(lo===null?0:hi-lo);}
function analyze(events,inputWarnings=[]){
 const warnings=[...inputWarnings],sessions=new Map(),sources=new Map(),seen=new Set();
 let malformed=0,duplicates=0;
 // Establish identity before processing even when metadata is later in an imported batch.
 for(const e of events)if(e?.kind==='session'&&e.sessionId)sources.set(e.source,e.sessionId);
 function sess(e){const id=e.sessionId||sources.get(e.source)||('source:'+e.source);if(!sessions.has(id))sessions.set(id,{id,model:null,version:null,forkedFrom:null,events:[],turns:new Map(),records:new Map(),totals:[],project:null,unknown:0});return sessions.get(id);}
 for(const e of events){if(!e||!e.kind){malformed++;continue;}const s=sess(e);
 const k=e.eventId||JSON.stringify([s.id,e.timestamp,e.kind,e.callId,e.turnId,e.responseId,e.usage,e.model,e.status,e.rateLimits]);
 if(seen.has(k)){duplicates++;continue;}seen.add(k);s.events.push(e);
 if(e.kind==='session'){s.forkedFrom=e.forkedFrom||null;s.version=e.version||null;s.project=e.project||null;}
 if(e.kind==='context'&&e.model)s.model=e.model;
 if(e.kind==='other')s.unknown++;
 }
 const results=[];
 for(const s of sessions.values()){
 s.events.sort((a,b)=>((time(a.timestamp)??Number.MAX_SAFE_INTEGER)-(time(b.timestamp)??Number.MAX_SAFE_INTEGER))||((a.seq||0)-(b.seq||0)));
 let active=null,counterPrev=null,legacyDelta=[],resets=0,baseline=null;const tools=new Map(),intervals=[];
 function getTurn(id){const key=id||active||'unattributed';if(!s.turns.has(key))s.turns.set(key,{id:key,start:null,end:null,status:'unknown',tools:0,firstOutput:null,reportedDurationMs:null,reportedTtftMs:null,records:[],delta:[],errors:0});return s.turns.get(key);}
 for(const e of s.events){const ts=time(e.timestamp);const t=getTurn(e.turnId);
 if(e.kind==='turn-start'){active=e.turnId||'turn-'+e.seq;const nt=getTurn(active);if(nt.start===null)nt.start=ts;nt.status='running';}
 if(e.kind==='turn-end'){const et=getTurn(e.turnId);et.end=ts;et.status=e.status||'completed';et.reportedDurationMs=e.reportedDurationMs??null;et.reportedTtftMs=e.reportedTtftMs??null;if(et.start===null&&e.startedAt!==null&&e.startedAt!==undefined)et.start=e.startedAt*1000;if(et.end===null&&e.completedAt!==null&&e.completedAt!==undefined)et.end=e.completedAt*1000;if(!e.turnId||e.turnId===active)active=null;}
 if(e.kind==='agent-message'||e.kind==='output-delta'){if(t.firstOutput===null&&ts!==null){t.firstOutput=ts;t.firstOutputIsDelta=e.kind==='output-delta';}}
 if(e.kind==='error')t.errors++;
 if(e.kind==='usage-record'&&e.responseId&&e.usage){if(!s.records.has(e.responseId)){s.records.set(e.responseId,e.usage);t.records.push(e.usage);}}
 if(e.kind==='usage-total'&&e.usage){const u=e.usage;s.totals.push({timestamp:e.timestamp,usage:u});if(counterPrev===null){baseline=u;counterPrev=u;}
 else if(u.total!==null&&counterPrev.total!==null){if(u.total<counterPrev.total){resets++;counterPrev=u;}
 else if(u.total>counterPrev.total){const d={};for(const key of keys)d[key]=(u[key]!==null&&counterPrev[key]!==null&&u[key]>=counterPrev[key])?u[key]-counterPrev[key]:null;legacyDelta.push(d);t.delta.push(d);counterPrev=u;}}}
 if(e.kind==='tool-start'&&e.callId){const id=(e.turnId||active||'')+'|'+e.callId;if(!tools.has(id)){tools.set(id,{callId:e.callId,turn:t.id,start:ts,end:null,name:e.tool||'tool',durationMs:null});t.tools++;}}
 if(e.kind==='tool-end'&&e.callId){let tool=[...tools.values()].reverse().find(x=>x.callId===e.callId&&x.end===null&&(x.turn===t.id||!e.turnId));if(!tool){tool={callId:e.callId,turn:t.id,start:null,end:null,name:'tool',durationMs:null};tools.set('end:'+e.callId,tool);t.tools++;}tool.end=ts;tool.durationMs=e.durationMs??null;if(tool.start===null&&ts!==null&&e.durationMs!==null&&e.durationMs!==undefined)tool.start=ts-e.durationMs;
 if(tool.start!==null&&ts!==null&&ts>=tool.start)intervals.push({turn:tool.turn,range:[tool.start,ts]});}
 }
 const turns=[...s.turns.values()].filter(t=>t.id!=='unattributed'||t.records.length||t.delta.length||t.tools||t.start!==null).map(t=>{
 const wallMs=t.start!==null&&t.end!==null&&t.end>=t.start?t.end-t.start:null;
 const toolMs=wallMs!==null?unionMs(intervals.filter(x=>x.turn===t.id).map(x=>x.range),t.start,t.end):null;
 const u=t.records.length?sumUsage(t.records):sumUsage(t.delta);
 return {...t,usage:u,usageBasis:t.records.length?'response-records':'cumulative-deltas-partial',wallMs,toolMs,unclassifiedMs:wallMs!==null?wallMs-toolMs:null,
 firstOutputMs:t.start!==null&&t.firstOutput!==null&&t.firstOutput>=t.start?t.firstOutput-t.start:null,
 effectiveOutputTokensPerSecond:wallMs>0&&u.output!==null?u.output/(wallMs/1000):null};});
 if(resets)warnings.push('Сессия '+s.id+': '+resets+' сброс(а) счётчика. Переход через сброс не суммируется.');
 if(s.forkedFrom)warnings.push('Сессия '+s.id+': ветка; накопительные счётчики могут включать наследованную историю.');
 results.push({id:s.id,project:s.project,model:s.model,version:s.version,forkedFrom:s.forkedFrom,events:s.events,turns,tools:[...tools.values()],responseCount:s.records.size||null,
 observedUsage:s.records.size?sumUsage([...s.records.values()]):sumUsage(legacyDelta),usageBasis:s.records.size?'response-records':'cumulative-deltas-partial',
 cumulative:s.totals.length?s.totals[s.totals.length-1].usage:null,baseline,resets,unknown:s.unknown,rateLimits:s.events.filter(e=>e.rateLimits).map(e=>({timestamp:e.timestamp,...e.rateLimits}))});
 }
 return {schema:'codex-observer-analysis/1',sessions:results,warnings,duplicates,malformed,
 coverage:'Только переданные события. Нет доступа к скрытым серверным очередям, TLS, всем операциям ОС или расходу подписки. Накопительные счётчики не суммируются между сессиями; первая legacy-точка — база, не расход выборки.',
 totals:sumUsage(results.map(x=>x.observedUsage)),eventCount:results.reduce((a,s)=>a+s.events.length,0)};
}
const api={normalize,parseText,analyze,usage,unionMs,sumUsage};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CodexTelemetry=api;
})(globalThis);
