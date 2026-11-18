/** Cross-language contract check against actual CLI outputs; no browser/provider. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {validateResearchRequest,validateSweepReport} from '../build/assistant/research.js';
import {decodeResearchCheckpoint,renderResearchTrace} from '../build/assistant/research-view.js';
const dir=path.resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Usage: node tools/check-research.mjs <research-demo directory>');
const json=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
for(const key of ['initial','readback']){const req=json(key+'.request.json'),report=json(key+'.report.json');validateResearchRequest(req);validateSweepReport(report,req.plan);assert.equal(report.localModelCalls,0);assert.equal(report.observedTokens,null);assert(report.utf8Bytes<=report.limitUtf8Bytes);}
const c=decodeResearchCheckpoint(fs.readFileSync(path.join(dir,'checkpoint.json'),'utf8'));const html=renderResearchTrace(c,'import');assert(html.includes('DISTINCT_MIDDLE_EVIDENCE'));assert(html.includes('turn-9')||html.includes('cmd-7'));assert(html.includes('Подлинность JSON'));assert(c.plan.goalRevision===1&&c.reports.length===2);
console.log(JSON.stringify({actualGoReportsAcceptedByTypeScript:true,importTraceRendered:true,reports:c.reports.length,guiRun:false,providerCalls:0,fixture:true},null,2));
