/** Research contracts and deterministic policy. No LLM, scheduler, or new store.
 * Findings are authored interpretations; reports are scoped observations.
 * Mirrored by native/tools/economy/research.go; shared fixtures test the boundary.
 */
import { assert, canonical, clone } from '../core/model.js';
import { ProgressState, recordCycle } from '../core/control.js';
import type { Task } from './contracts.js';

export type Coverage = 'complete' | 'partial' | 'unknown';
export interface ResearchBudget { maxSweeps: number; wallSeconds: number; outputUtf8Bytes: number; maxNoProgress: number }
export interface Hypothesis { id: string; claim: string; predicts: string[]; counterEvidence?: string[]; state: 'open'|'supported'|'weakened'|'refuted'|'unresolved' }
export interface ProbeOperation {
 id: string; op: string; path?: string; paths?: string[]; query?: string; startLine?: number; lines?: number;
 offset?: number; length?: number; dependsOn?: string[]; from?: string; limit?: number; before?: number; after?: number;
 includeGenerated?: boolean; artifact?: string; stream?: string; check?: string;
}
export interface Probe { id: string; question: string; discriminates: string[]; operations: ProbeOperation[];
 effect: 'read-only'|'external'|'mutation'; priority: number; expectedInformation: string; acceptance: string }
export interface ResearchPlan {
 schema: 1; investigationId: string; taskId: string; goalRevision: number; originalGoal: string;
 planVersion: number; question: string; scope: string[]; stopRules: string[]; budget: ResearchBudget;
 hypotheses: Hypothesis[]; probes: Probe[];
}
export interface SweepRequest {
 sweepId: string; plan: ResearchPlan;
 sourceSnapshot: { rootHash: string; pins: {path: string; sha256: string}[] };
 limits: {outputUtf8Bytes: number; wallSeconds: number};
 permissionScope: {paths: string[]; effect: 'read-only'; allowGit: boolean};
}
export interface EvidenceRef {
 id: string; probeId: string; operationId: string; kind: 'file-span'|'log-span'|'test-run'|'external-source'|'observation';
 locator: string; sha256: string; observedAt: string; coverage: Coverage; sourceHash: string; noveltyKey: string; negative: boolean;
}
export interface SweepReport {
 schema: 1; sweepId: string; investigationId: string; taskId: string; goalRevision: number; planVersion: number;
 state: 'observed'|'partial'; sourceHash: string; sourceCoverage: Coverage;
 probes: {probeId: string; question?: string; state: string; coverage: Coverage; evidenceIds: string[]; summary: string}[];
 evidenceRefs: EvidenceRef[]; excerpts: {evidenceId: string; text: string; truncated: boolean}[];
 summary: string; gaps: string[]; unknownEffects: string[]; untestedHypotheses: string[];
 nextSuggestedQuestions: string[]; nextAction: string; reportArtifact: string; reportSha256: string;
 durationMs: number; utf8Bytes: number; limitUtf8Bytes: number; truncated: boolean; replayed: boolean;
 resumed: boolean; localModelCalls: 0; observedTokens: number|null;
}
export interface Finding {
 id: string; assertion: string; evidenceIds: string[]; counterEvidenceIds: string[];
 kind: 'observed'|'inferred'|'hypothesis'; scope: string; limitations: string[]; nextCheck?: string;
 author: 'user'|'agent';
}
export interface ResearchCheckpoint {
 schema: 1; sequence: number; plan: ResearchPlan; reports: SweepReport[]; findings: Finding[];
 nextAction: string; status: 'planning'|'probing'|'evaluating'|'blocked'|'review';
}
const utf8=(s:string)=>new TextEncoder().encode(s).byteLength;
const idOK=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(s);
const hashOK=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const text=(s:unknown,n:number)=>typeof s==='string'&&s.trim()!==''&&utf8(s)<=n&&!s.includes('\0');
const int=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
const coverage=(v:unknown)=>v==='complete'||v==='partial'||v==='unknown';
const secret=(p:string)=>/^\.env(?:\.|$)|^(?:auth\.json|id_rsa|id_ed25519)$|\.(?:key|pfx|p12)$/i.test(p);
export function safeResearchPath(p:unknown):p is string {
 return typeof p==='string'&&utf8(p)<=1024&&(p==='.'||p!==''&&!/[\\:\x00\r\n]/.test(p)&&!p.startsWith('/')&&p.split('/').every(c=>c!==''&&c!=='.'&&c!=='..'&&!secret(c)));
}
const under=(p:string,roots:string[])=>safeResearchPath(p)&&roots.some(r=>r==='.'||r===p||p.startsWith(r+'/'));
function strings(v:unknown,max:number,size:number):v is string[]{return Array.isArray(v)&&v.length<=max&&v.every(x=>text(x,size));}

export function validateResearchRequest(r:SweepRequest,task?:Pick<Task,'id'|'goalRevision'|'original'>):void {
 assert(r&&typeof r==='object'&&utf8(JSON.stringify(r))<=256*1024,'RESEARCH_SIZE','Предел плана — 256 КиБ');
 const p=r.plan;assert(p&&p.schema===1&&idOK(r.sweepId)&&r.sweepId.length<=80&&idOK(p.investigationId)&&idOK(p.taskId),'RESEARCH_ID','Неверная идентичность');
 assert(int(p.goalRevision,1,Number.MAX_SAFE_INTEGER)&&int(p.planVersion,1,Number.MAX_SAFE_INTEGER),'RESEARCH_VERSION','Неверная редакция');
 assert(text(p.originalGoal,65536)&&text(p.question,2048),'RESEARCH_GOAL','Нужны исходная цель и вопрос');
 if(task)assert(p.taskId===task.id&&p.goalRevision===task.goalRevision&&p.originalGoal===task.original,'GOAL_CONFLICT','План не соответствует текущей исходной цели');
 assert(Array.isArray(p.scope)&&p.scope.length>0&&p.scope.length<=16&&p.scope.every(safeResearchPath),'RESEARCH_SCOPE','Неверная область');
 const permission=r.permissionScope;
 assert(permission&&permission.effect==='read-only'&&typeof permission.allowGit==='boolean'&&Array.isArray(permission.paths)&&permission.paths.length>0&&permission.paths.length<=16&&permission.paths.every(s=>under(s,p.scope)),'RESEARCH_SCOPE','Пакет может только сужать область чтения');
 assert(r.sourceSnapshot&&hashOK(r.sourceSnapshot.rootHash)&&Array.isArray(r.sourceSnapshot.pins)&&r.sourceSnapshot.pins.length<=32,'RESEARCH_SOURCE','Нужна привязка к источнику');
 const pins=new Set<string>();for(const pin of r.sourceSnapshot.pins){assert(under(pin.path,permission.paths)&&hashOK(pin.sha256)&&!pins.has(pin.path),'RESEARCH_SOURCE','Неверная или повторная фиксация источника');pins.add(pin.path);}
 assert(strings(p.stopRules,8,1024)&&p.stopRules.length>0,'RESEARCH_STOP','Нужны условия остановки');
 const b=p.budget;assert(b&&int(b.maxSweeps,1,32)&&int(b.maxNoProgress,1,5)&&int(b.wallSeconds,1,300)&&int(b.outputUtf8Bytes,2048,24576),'RESEARCH_BUDGET','Нужны конечные пределы');
 assert(r.limits&&int(r.limits.outputUtf8Bytes,2048,b.outputUtf8Bytes)&&int(r.limits.wallSeconds,1,b.wallSeconds),'RESEARCH_LIMITS','Нельзя расширять пределы плана');
 assert(Array.isArray(p.hypotheses)&&p.hypotheses.length>=2&&p.hypotheses.length<=5,'RESEARCH_HYPOTHESES','Для диагностики нужны альтернативы; простое чтение — через local_batch');
 const hs=new Set<string>();for(const h of p.hypotheses){assert(idOK(h.id)&&!hs.has(h.id)&&text(h.claim,2048)&&strings(h.predicts,8,1024)&&h.predicts.length>0&&['open','supported','weakened','refuted','unresolved'].includes(h.state),'RESEARCH_HYPOTHESIS','Неверная гипотеза');assert(h.counterEvidence===undefined||Array.isArray(h.counterEvidence)&&h.counterEvidence.length<=32&&h.counterEvidence.every(idOK),'RESEARCH_HYPOTHESIS','Неверные ссылки на контрдоказательства');hs.add(h.id);}
 assert(Array.isArray(p.probes)&&p.probes.length>0&&p.probes.length<=12,'RESEARCH_PROBES','Нужно от 1 до 12 проверок');
 const probes=new Set<string>(),ops=new Map<string,ProbeOperation>();
 for(const probe of p.probes){
  assert(idOK(probe.id)&&!probes.has(probe.id)&&text(probe.question,1024)&&text(probe.expectedInformation,1024)&&text(probe.acceptance,2048)&&int(probe.priority,0,100),'RESEARCH_PROBE','Неверная проверка');probes.add(probe.id);
  assert(probe.effect==='read-only','RESEARCH_EFFECT','Мутации не входят в диагностический пакет');
  assert(Array.isArray(probe.discriminates)&&probe.discriminates.length>0&&probe.discriminates.length<=5&&new Set(probe.discriminates).size===probe.discriminates.length&&probe.discriminates.every(h=>hs.has(h)),'RESEARCH_DISCRIMINATION','Проверка должна различать известные гипотезы');
  assert(Array.isArray(probe.operations)&&probe.operations.length>0,'RESEARCH_OPERATIONS','Пустая проверка');
  for(const op of probe.operations){
   assert(idOK(op.id)&&!ops.has(op.id),'RESEARCH_OPERATION','Повтор или неверный ID операции');
   assert(['files','search','read','read_bytes','read_matches','metadata','hash','inspect','git_status','git_diff'].includes(op.op),'RESEARCH_EFFECT','Только известные операции чтения, без check');
   if(['files','search'].includes(op.op))assert(Array.isArray(op.paths)&&op.paths.length>0&&op.paths.every(s=>under(s,permission.paths)),'RESEARCH_SCOPE','Поиск требует явную область');
   if(['read','read_bytes','metadata','hash'].includes(op.op))assert(typeof op.path==='string'&&under(op.path,permission.paths),'RESEARCH_SCOPE','Чтение вне области');
   if(op.op==='inspect')assert(idOK(op.artifact),'RESEARCH_ARTIFACT','Нужен адрес сохранённого материала');
   if(op.op.startsWith('git_'))assert(permission.allowGit&&under('.',permission.paths),'RESEARCH_GIT','Git требует явного разрешения и области всего проекта');
   assert(op.dependsOn===undefined||Array.isArray(op.dependsOn)&&op.dependsOn.every(idOK),'RESEARCH_DEPENDENCY','Неверные зависимости');
   ops.set(op.id,op);
  }
 }
 assert(ops.size<=32,'RESEARCH_OPERATIONS','Не более 32 операций');
 assert(r.limits.outputUtf8Bytes>=1500+p.probes.length*220+ops.size*620,'RESEARCH_OUTPUT_LIMIT','Предел не вмещает ссылки на свидетельства; чтение не начинается');
 const visiting=new Set<string>(),done=new Set<string>();
 const visit=(id:string):void=>{assert(!visiting.has(id),'RESEARCH_CYCLE','Цикл зависимостей');if(done.has(id))return;const op=ops.get(id);assert(op,'RESEARCH_DEPENDENCY','Отсутствующая зависимость');visiting.add(id);if(op.op==='read_matches')assert(op.from&&ops.get(op.from)?.op==='search','RESEARCH_DEPENDENCY','read_matches требует search');for(const d of [...(op.dependsOn??[]),...(op.from?[op.from]:[])])visit(d);visiting.delete(id);done.add(id);};
 for(const id of ops.keys())visit(id);
}

/** An explicit intent classification, not a semantic NLP diagnosis. */
export function researchRoute(kind:'read-range'|'known-search'|'diagnose'|'compare-implementations'|'unknown-behaviour'): 'direct'|'investigation' {
 return kind==='read-range'||kind==='known-search'?'direct':'investigation';
}
export function validateSweepReport(r:SweepReport,p:ResearchPlan):void {
 assert(r&&r.schema===1&&r.taskId===p.taskId&&r.investigationId===p.investigationId&&r.planVersion===p.planVersion&&r.goalRevision===p.goalRevision,'RESEARCH_REPORT','Результат относится к другой работе или версии');
 assert(idOK(r.sweepId)&&idOK(r.reportArtifact)&&hashOK(r.reportSha256)&&hashOK(r.sourceHash)&&coverage(r.sourceCoverage),'RESEARCH_REPORT','Неверные ссылки/покрытие');
 assert(r.localModelCalls===0&&(r.observedTokens===null||int(r.observedTokens,0,Number.MAX_SAFE_INTEGER))&&int(r.durationMs,0,Number.MAX_SAFE_INTEGER),'RESEARCH_METRIC','Неизвестные токены не должны выдаваться за измеренный ноль');
 assert(Array.isArray(r.evidenceRefs)&&r.evidenceRefs.length<=32&&Array.isArray(r.probes)&&r.probes.length===p.probes.length,'RESEARCH_REPORT','Неверное число проверок/свидетельств');
 assert(strings(r.gaps,4096,4096)&&strings(r.unknownEffects,32,4096)&&strings(r.nextSuggestedQuestions,32,4096)&&Array.isArray(r.untestedHypotheses),'RESEARCH_REPORT','Неверные пробелы/следующий шаг');
 const ids=new Set<string>(),opids=new Set<string>(),probeids=new Set<string>();
 for(const ev of r.evidenceRefs){const probe=p.probes.find(q=>q.id===ev.probeId);assert(probe&&probe.operations.some(op=>op.id===ev.operationId),'RESEARCH_EVIDENCE','Свидетельство не связано с операцией');assert(idOK(ev.id)&&!ids.has(ev.id)&&!opids.has(ev.operationId)&&idOK(ev.locator)&&hashOK(ev.sha256)&&hashOK(ev.noveltyKey)&&ev.sourceHash===r.sourceHash&&coverage(ev.coverage),'RESEARCH_EVIDENCE','Повтор или неверное свидетельство');ids.add(ev.id);opids.add(ev.operationId);}
 for(const probe of r.probes){const original=p.probes.find(q=>q.id===probe.probeId);assert(original&&!probeids.has(probe.probeId)&&coverage(probe.coverage)&&['observed','blocked'].includes(probe.state)&&Array.isArray(probe.evidenceIds)&&probe.evidenceIds.length===original.operations.length,'RESEARCH_REPORT','Неполная проверка');probeids.add(probe.probeId);assert(probe.evidenceIds.every(id=>r.evidenceRefs.some(e=>e.id===id&&e.probeId===probe.probeId))&&new Set(probe.evidenceIds).size===probe.evidenceIds.length,'RESEARCH_EVIDENCE','Чужая ссылка');}
 assert(opids.size===p.probes.reduce((n,q)=>n+q.operations.length,0),'RESEARCH_EVIDENCE','Пропущена операция');
}

export function startResearch(plan:ResearchPlan):ResearchCheckpoint {return {schema:1,sequence:1,plan:clone(plan),reports:[],findings:[],nextAction:'collect_read_only_evidence',status:'planning'};}
export function canSweep(checkpoint:ResearchCheckpoint,progress:ProgressState):boolean {
 return checkpoint.status!=='blocked'&&checkpoint.reports.length<checkpoint.plan.budget.maxSweeps&&progress.noProgress<Math.min(progress.maxNoProgress,checkpoint.plan.budget.maxNoProgress);
}
/** Shared task progress is supplied by TaskStore; creating a new session or
 * investigation does not reset it. Observed positive bytes may be useful even with partial coverage; negative evidence requires complete coverage.
 * The caller must authenticate report provenance; importing JSON is not proof.
 */
export function applySweep(checkpoint:ResearchCheckpoint,progress:ProgressState,report:SweepReport):{checkpoint:ResearchCheckpoint;progress:ProgressState} {
 validateSweepReport(report,checkpoint.plan);
 const previous=checkpoint.reports.find(r=>r.sweepId===report.sweepId);
 if(previous){assert(previous.reportSha256===report.reportSha256,'SWEEP_ID_CONFLICT','Результат с тем же ID изменился');return {checkpoint:clone(checkpoint),progress:clone(progress)};}
 assert(canSweep(checkpoint,progress),'RESEARCH_STOP','Лимит исчерпан; смена сессии его не сбрасывает');
 const fresh=report.evidenceRefs.filter(e=>(e.coverage==='complete'||e.coverage==='partial'&&!e.negative)&&report.sourceCoverage!=='unknown').map(e=>e.noveltyKey);
 const nextProgress=recordCycle(progress,fresh,[]);
 const next=clone(checkpoint);next.sequence++;next.reports.push(clone(report));next.nextAction=report.nextAction;next.status='evaluating';
 if(nextProgress.noProgress>=Math.min(nextProgress.maxNoProgress,next.plan.budget.maxNoProgress)||next.reports.length>=next.plan.budget.maxSweeps){next.status='blocked';next.nextAction='Change the diagnostic approach or request an explicit owner decision; no automatic model continuation.';}
 return {checkpoint:next,progress:nextProgress};
}
export function addFinding(checkpoint:ResearchCheckpoint,f:Finding):ResearchCheckpoint {
 assert(idOK(f.id)&&text(f.assertion,4096)&&text(f.scope,2048)&&['user','agent'].includes(f.author)&&['observed','inferred','hypothesis'].includes(f.kind),'RESEARCH_FINDING','Неверный вывод');
 assert(Array.isArray(f.evidenceIds)&&Array.isArray(f.counterEvidenceIds)&&strings(f.limitations,16,2048),'RESEARCH_FINDING','Неверные основания');
 const all=new Map(checkpoint.reports.flatMap(r=>r.evidenceRefs.map(e=>[e.id,e] as const)));
 assert([...f.evidenceIds,...f.counterEvidenceIds].every(id=>all.has(id)),'RESEARCH_FINDING','Вывод ссылается на отсутствующее свидетельство');
 assert(f.kind==='hypothesis'||f.evidenceIds.length>0,'RESEARCH_FINDING','Наблюдение и вывод требуют основания');
 const partial=f.evidenceIds.some(id=>all.get(id)?.coverage!=='complete');
 assert(!partial||f.limitations.length>0&&text(f.nextCheck,2048),'RESEARCH_COVERAGE','Неполные данные требуют оговорки и следующей проверки');
 const old=checkpoint.findings.find(x=>x.id===f.id);if(old){assert(canonical(old)===canonical(f),'FINDING_IMMUTABLE','Для исправленного вывода создайте новую версию/ID');return clone(checkpoint);}
 assert(checkpoint.findings.length<64,'RESEARCH_LIMIT','Нужен ограниченный итог');const c=clone(checkpoint);c.sequence++;c.findings.push(clone(f));return c;
}
export function researchFreshness(c:ResearchCheckpoint,t:Pick<Task,'id'|'original'|'goalRevision'>):'current'|'stale-goal' {
 return c.plan.taskId===t.id&&c.plan.goalRevision===t.goalRevision&&c.plan.originalGoal===t.original?'current':'stale-goal';
}
export function continuationCard(c:ResearchCheckpoint,maxBytes=12000):string {
 const body=JSON.stringify({taskId:c.plan.taskId,goalRevision:c.plan.goalRevision,originalGoal:c.plan.originalGoal,planVersion:c.plan.planVersion,question:c.plan.question,hypotheses:c.plan.hypotheses,stopRules:c.plan.stopRules,reports:c.reports.map(r=>({sweepId:r.sweepId,artifact:r.reportArtifact,sha256:r.reportSha256,gaps:r.gaps,unknownEffects:r.unknownEffects})),findings:c.findings,nextAction:c.nextAction});
 assert(utf8(body)<=maxBytes,'CONTEXT_LIMIT','Обязательный пакет продолжения не помещается; цель не обрезана');return body;
}
