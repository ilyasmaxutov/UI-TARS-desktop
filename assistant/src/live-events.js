/* Adapter only. Existing CodexTelemetry owns accounting; no model/network calls here. */
(function(root){
'use strict';
const T=typeof module!=='undefined'&&module.exports?require('./telemetry.js'):root.CodexTelemetry;
function normalizeEnvelope(envelope){
 if(!envelope||!Number.isSafeInteger(envelope.sequence)||envelope.sequence<1||typeof envelope.sessionId!=='string'||!envelope.frame)return null;
 const e=T.normalize({...envelope.frame,timestamp:envelope.at},'host:'+envelope.sessionId,envelope.sequence);
 if(!e)return null;e.eventId=envelope.sessionId+':'+envelope.sequence;
 e.sessionId=e.sessionId||envelope.frame.params?.thread?.id||envelope.sessionId;
 // Source time is explicitly host receipt time; it cannot prove remote processing or TTFT.
 e.clockSource='host-receipt';e.provenance=envelope.origin;e.truncated=Boolean(envelope.truncated);
 return e;
}
function analyzeEnvelopes(envelopes,gap=false){
 const warnings=['Временная шкала: время получения хостом, если Codex не сообщил собственную длительность.'];
 if(gap)warnings.push('Есть пробел истории. Сумма относится только к наблюдённой выборке.');
 if(envelopes.some(e=>e.truncated))warnings.push('Часть кадров превышает предел хранения; отсутствующие данные не восстановлены.');
 if(envelopes.some(e=>e.origin==='synthetic-peer'))warnings.push('В выборке есть синтетический протокольный стенд — это не вызов модели.');
 return T.analyze(envelopes.map(normalizeEnvelope).filter(Boolean),warnings);
}
const api={normalizeEnvelope,analyzeEnvelopes};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DeskLiveEvents=api;
})(globalThis);
