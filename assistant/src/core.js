/* Assistant Desk: interaction model. No provider calls or filesystem effects. */
(function(root){
'use strict';
const clone = x => JSON.parse(JSON.stringify(x));
const scenarios = [
  {id:'ready',name:'Первое поручение',description:'Проверить понимание цели и английское задание до отправки.'},
  {id:'running',name:'Работа идёт',description:'Вмешаться по месту, не теряя текущую задачу.'},
  {id:'steer-race',name:'Ход уже завершился',description:'Уточнение не отправляется в устаревший ход и не начинает новый само.'},
  {id:'unknown',name:'Ответ на отправку потерян',description:'Сначала сверка; повторное сообщение заблокировано.'},
  {id:'goal-changed',name:'Цель изменилась',description:'Результат для старой редакции нельзя принять для новой.'},
  {id:'conflict',name:'Файл изменён вручную',description:'Ручная версия не затирается предложением агента.'},
  {id:'review-failed',name:'Ложное «готово»',description:'Отчёт агента отделён от проваленной проверки.'},
  {id:'cancel',name:'Отмена не подтверждена',description:'Запрос остановки не означает остановку и освобождение ресурсов.'},
  {id:'quota',name:'Лимит подключения',description:'Ожидание без повторных модельных запросов.'},
  {id:'switch',name:'Замена исполнителя',description:'Переход после остановки, с явной передачей контекста.'},
  {id:'draft-conflict',name:'Две редакции промпта',description:'Старая вкладка не перезаписывает новую версию.'},
  {id:'disconnected',name:'Нет исполнителя',description:'Черновик и наблюдение доступны; отправка не притворяется успешной.'}
];
const initialPrompt = `You are the implementation worker for the user's project.

GOAL
Fix settings persistence while retaining compatibility with existing configuration files.

REQUIRED OUTCOMES
1. Inspect the existing read/write path and relevant logs before proposing changes.
2. Identify the cause using file evidence. Do not substitute a UI status for persistence.
3. Preserve existing config field names and support older files.
4. Provide a focused diff and evidence for each acceptance criterion.

BOUNDARIES
Do not launch the application, a browser, a development server, or GUI automation.
Do not weaken existing tests or change the user's acceptance criteria.
Work only within explicitly granted project paths. Do not publish changes automatically.
If a required check is unavailable, report the specific gap; do not claim it passed.

REPORT
Use Russian for the user-facing report. Separate implemented, tested, and unverified claims.`;
function makeState(id='ready') {
 const s={scenario:id,revision:1,goalRevision:1,resultGoalRevision:1,promptRevision:1,expectedPromptRevision:1,
 original:'Исправь сохранение настроек. Старые файлы должны продолжать работать. Не запускай приложение. Сначала прочитай код и логи, затем проверь изменения допустимыми способами.',
 english:initialPrompt,goalTitle:'Сохранение настроек без потери совместимости',project:'Platform Studio',
 status:'ready',backend:'scenario',connected:true,activeTurn:'turn-example-07',pendingMessage:'',queuedMessage:'',
 receipt:'none',review:'not-run',resultVersion:'proposal-03',baseVersion:'base-02',fileConflict:false,
 accepted:null,published:false,commandCount:0,events:[],model:'Codex · исполнитель',nextModel:'',
 limitations:['Приложение, браузер и dev-server не запускать','Не менять формат существующих файлов','Оригинал изменяется только после принятия'],
 mergeChoice:null,returnScreen:'task'};
 s.goalHistory=[{revision:1,text:s.original}];s.promptHistory=[{revision:1,text:s.english,goalRevision:1}];
 if(['running','steer-race','switch'].includes(id)) s.status='running';
 if(id==='unknown'){s.status='unknown';s.receipt='unknown';s.commandCount=1;}
 if(id==='goal-changed'){s.status='result';s.review='passed';s.goalRevision=2;s.original+=' Сохрани неизвестные поля.';s.goalHistory.push({revision:2,text:s.original});}
 if(id==='conflict'){s.status='result';s.review='passed';s.fileConflict=true;}
 if(id==='review-failed'){s.status='result';s.review='failed';}
 if(id==='cancel')s.status='cancel_requested';
 if(id==='quota')s.status='waiting_quota';
 if(id==='draft-conflict'){s.expectedPromptRevision=1;s.promptRevision=2;s.english+='\nADDITIONAL CHECK\nPreserve unknown configuration fields.';s.promptHistory.push({revision:2,text:s.english,goalRevision:1});}
 if(id==='disconnected'){s.connected=false;s.status='draft';}
 s.events=[{kind:'scenario',text:'Сценарные данные. Реальный Codex не запускался.'}];
 return s;
}
function canAccept(s){return s.status==='result'&&s.review==='passed'&&s.goalRevision===s.resultGoalRevision&&!s.fileConflict;}
function reduce(state, action){
 const s=clone(state); let message='';
 const log=(kind,text)=>s.events.push({kind,text,seq:s.events.length+1});
 switch(action.type){
 case 'START':
   if(!s.connected){message='Подключение отсутствует. Задание сохранено, отправки нет.';break;}
   if(!['ready','draft','stopped'].includes(s.status)){message='Сначала завершите или сверяйте текущую попытку.';break;}
   if(s.promptHistory.at(-1)?.goalRevision!==s.goalRevision||!s.english.trim()){message='Сначала сохраните поручение для текущей редакции цели.';break;}
   s.status='running';s.commandCount++;s.receipt='confirmed';log('start','Сценарный запуск принят. Оригинал запроса сохранён.');break;
 case 'COMPLETE':
   if(s.status!=='running'){message='Нет активного хода.';break;}
   s.status='result';s.review='passed';s.resultGoalRevision=s.goalRevision;
   log('result','Сценарный результат предъявлен. Это не запись в исходный проект.');break;
 case 'STEER':
   if(!action.text?.trim()){message='Напишите конкретное уточнение.';break;}
   s.pendingMessage=action.text.trim();
   if(s.scenario==='steer-race'){s.status='result';s.review='passed';s.queuedMessage=s.pendingMessage;message='Ход завершился до доставки. Уточнение сохранено для отдельного продолжения.';log('race',message);break;}
   if(s.status==='unknown'){s.queuedMessage=s.pendingMessage;message='Сначала нужно установить судьбу прежней отправки.';break;}
   if(s.status!=='running'){s.queuedMessage=s.pendingMessage;message='Уточнение сохранено. Новый ход начнётся только отдельной командой.';break;}
   s.commandCount++;log('steer','Уточнение адресовано активному ходу: '+s.pendingMessage);message='Уточнение доставлено в сценарии; исправление пока не подтверждено.';break;
 case 'CONTINUE':
   if(['unknown','running','cancel_requested','waiting_quota'].includes(s.status)||!s.connected){message='Продолжение сейчас недопустимо.';break;}
   if(!s.queuedMessage){message='Нет сохранённого уточнения.';break;}
   s.status='running';s.commandCount++;log('continue',s.queuedMessage);s.queuedMessage='';s.review='not-run';s.accepted=null;break;
 case 'CANCEL':
   if(s.status!=='running'){message='Нет управляемого активного хода.';break;}
   s.status='cancel_requested';s.commandCount++;log('cancel','Запрошена отмена. Остановка и освобождение ещё не подтверждены.');break;
 case 'STOP_OBSERVED':
   if(s.status!=='cancel_requested'){message='Не было запроса остановки.';break;}
   s.status='stopped';log('stopped','В сценарии получено подтверждение завершения хода.');break;
 case 'RECONCILE':
   if(s.status!=='unknown'){message='Нет спорной отправки.';break;}
   s.receipt='confirmed';s.status='running';log('reconcile','Найдена прежняя команда. Новый запрос не отправлен.');break;
 case 'RETRY':message=s.status==='unknown'?'Повтор запрещён: исход прежней команды неизвестен.':'Используйте явное продолжение с тем же заданием.';break;
 case 'EDIT_GOAL':
   if(action.text?.trim()){s.original=action.text.trim();s.goalRevision++;s.goalHistory.push({revision:s.goalRevision,text:s.original});s.accepted=null;if(s.status==='accepted')s.status='result';log('goal','Новая редакция цели. Старый результат требует повторной проверки.');}break;
 case 'SAVE_PROMPT':
   if(action.expectedRevision!==s.promptRevision){s.unsavedPrompt=action.text;message='Редакция изменилась в другом окне. Ваш текст сохранён отдельно; перезаписи нет.';log('conflict',message);break;}
   s.english=action.text;s.promptRevision++;s.promptHistory.push({revision:s.promptRevision,text:s.english,goalRevision:s.goalRevision});s.expectedPromptRevision=s.promptRevision;log('prompt','Сохранён промпт v'+s.promptRevision+'. Текущий ход не переписан.');break;
 case 'KEEP_LOCAL_PROMPT':
   if(s.unsavedPrompt){s.english=s.unsavedPrompt;s.unsavedPrompt='';s.promptRevision++;s.promptHistory.push({revision:s.promptRevision,text:s.english,goalRevision:s.goalRevision});s.expectedPromptRevision=s.promptRevision;log('prompt','Создана новая версия из локального черновика.');}break;
 case 'ACCEPT':
   if(!canAccept(s)){message=s.fileConflict?'Сначала разрешите конфликт файла.':s.review!=='passed'?'Есть незакрытая проверка.':'Результат относится к прежней цели. Нужна повторная проверка.';break;}
   s.accepted={result:s.resultVersion,goalRevision:s.goalRevision};s.status='accepted';log('accepted','Принят только сценарный снимок. Файлы на диске не изменены.');break;
 case 'REQUEST_FIX':
   s.queuedMessage=action.text||'Исправь несовместимость со старым конфигом, не изменяя критерии.';
   s.review='failed';s.accepted=null;message='Замечание подготовлено. Отправка — отдельное продолжение.';log('review',s.queuedMessage);break;
 case 'MERGE':
   if(!s.fileConflict){message='Нет конфликта.';break;}
   if(!['ours','merged'].includes(action.choice)){message='Выберите сохранение ручной версии или объединённое предложение.';break;}
   s.mergeChoice=action.choice;s.fileConflict=false;s.review='not-run';s.resultVersion='proposal-04';s.accepted=null;
   log('merge','Создано сценарное предложение v4. Оно ещё не проверено и не опубликовано.');break;
 case 'RECHECK':
   if(s.fileConflict){message='Сначала нужно разрешить конфликт.';break;}
   s.review='passed';s.resultGoalRevision=s.goalRevision;s.status='result';log('check','Сценарная повторная проверка текущей редакции. Реальные тесты не запускались.');break;
 case 'SWITCH_REQUEST':
   s.nextModel=action.model||'Другой исполнитель';
   if(s.status==='running'){message='Замена запланирована после подтверждённой остановки. Данные ещё не переданы.';}
   else message='Нужно подтвердить адресата и переносимый контекст.';
   log('handoff',message);break;
 case 'SWITCH_CONFIRM':
   if(['running','cancel_requested','unknown'].includes(s.status)){message='Нельзя менять исполнителя до сверки и остановки.';break;}
   if(!action.allowTransfer){message='Передача контекста новому исполнителю не разрешена.';break;}
   s.model=s.nextModel||s.model;s.nextModel='';log('handoff','Сценарная привязка изменена. Новый вызов не начат.');break;
 case 'LOCAL_DRAFT':
   s.original=action.text||s.original;s.status='draft';s.goalTitle=action.title||'Новая работа';s.review='not-run';s.accepted=null;
   s.english='';s.goalRevision=1;s.promptRevision=1;s.expectedPromptRevision=1;s.goalHistory=[{revision:1,text:s.original}];s.promptHistory=[{revision:1,text:'',goalRevision:1}];log('draft','Сохранён локальный черновик. AI-преобразование не выполнялось.');break;
 default:message='Неизвестное действие; состояние не изменено.';
 }
 s.revision++;return {state:s,message};
}
function buildHandoff(s){return {schema:'assistant-handoff/1',mode:'design-not-executed',project:s.project,goal:{revision:s.goalRevision,original:s.original},prompt:{revision:s.promptRevision,english:s.english},goalHistory:s.goalHistory,promptHistory:s.promptHistory,constraints:s.limitations,result:{id:s.resultVersion,review:s.review},openCorrection:s.queuedMessage||null,requiresTransferApproval:true};}
const api={scenarios,makeState,reduce,canAccept,buildHandoff,initialPrompt};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.AssistantCore=api;
})(globalThis);
