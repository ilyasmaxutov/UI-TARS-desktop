import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationAvailability, renderContinuationPreview } from '../build/assistant/continuation-view.js';
import { HostExecutionService } from '../build/assistant/service.js';

const preview = {schema:1,taskId:'task',goalRevision:1,text:'{"originalGoal":"Continue"}',utf8Bytes:27,maxUtf8Bytes:12288,sha256:'a'.repeat(64),unresolvedCommands:0,activeSessions:0,research:{present:false},omissions:{reports:0,evidenceRefs:0,hypotheses:0,findings:0,rawOutputs:true}};
const session = {id:'old',taskId:'task',status:'idle'};

test('continuation preview is a local read with no implicit start or submit', async()=>{
    const calls=[];
    const service=new HostExecutionService(async(command,args)=>{calls.push({command,args});return preview;});
    assert.equal(await service.call('codex_continuation',{taskId:'task'}),preview);
    assert.deepEqual(calls,[{command:'assistant_rpc',args:{operation:'codex_continuation',params:{taskId:'task'}}}]);
});
test('a new context cannot hide unresolved effects or another running session',()=>{
    for(const changed of [{unresolvedCommands:1},{activeSessions:1},{uncertainSessions:1}])
        assert.equal(continuationAvailability({...preview,...changed},session,[],true,false).allowed,false);
    assert.equal(continuationAvailability(preview,session,[{method:'turn/start',state:'unverified_outcome'}],true,false).allowed,false);
    assert.equal(continuationAvailability(preview,session,[],true,true).allowed,false);
    assert.equal(continuationAvailability(preview,{...session,status:'state_unknown'},[],true,false).allowed,false);
    assert.equal(continuationAvailability(null,session,[],true,false).allowed,false);
    assert.equal(continuationAvailability(preview,session,[],true,false).allowed,true);
});
test('preview distinguishes stale, blocked and omitted details without turning bytes into tokens',()=>{
    const html=renderContinuationPreview({...preview,text:'<script>bad()</script>',research:{present:true,status:'blocked',freshness:'stale-goal'},omissions:{...preview.omissions,evidenceRefs:3}},'');
    assert(!html.includes('<script>'));
    for(const re of [/устаревшее/,/не сбрасывает/,/ссылки на оригиналы/,/байт/,/не равен полному контексту/])assert.match(html,re);
    assert(!html.includes('токенов'));
});
test('a failed preview cannot be rendered as a usable capsule',()=>{
    const html=renderContinuationPreview(null,'CONTINUATION_LIMIT: цель не помещается <unsafe>');
    assert.match(html,/CONTINUATION_LIMIT/);assert(!html.includes('<unsafe>'));assert(!html.includes('будут переданы'));
});
