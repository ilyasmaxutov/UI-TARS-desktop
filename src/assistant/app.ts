import { ResearchCheckpoint } from './research.js';
import { decodeResearchCheckpoint, renderResearchTrace } from './research-view.js';
import { id, WorkspaceBinding } from '../core/model.js';
import { ExternalIntent, SessionEvent, SessionRef, Task } from './contracts.js';
import { HostExecutionService } from './service.js';
import { actionAvailability, mergeEvents, modelClaims } from './view-model.js';

declare global {
 interface Window { DeskLiveEvents: {analyzeEnvelopes:(events:SessionEvent[],gap:boolean)=>any}; CodexTelemetry:{parseText:(text:string,source:string)=>any;analyze:(events:any[],warnings:string[])=>any} }
}
const $=(s:string)=>document.getElementById(s)!;
const esc=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const service=window.__TAURI__?.core?.invoke ? new HostExecutionService(window.__TAURI__.core.invoke) : null;
let tasks:Task[]=[], task:Task|null=null, session:SessionRef|null=null, commands:ExternalIntent[]=[], events:SessionEvent[]=[];
let cursor=0,gap=false,busy=false,polling=false,screen='work',binding:WorkspaceBinding|null=null,configured=false,notice='';
let research:ResearchCheckpoint|null=null, researchOrigin:'host'|'import'='host';
let imported:any=null;let selectionGeneration=0,operationCount=0;
const storeKey='platform-studio-assistant-v03';
let local:{selectedTask:string|null;selectedSession:string|null;drafts:Record<string,string>;pending:Record<string,unknown>|null;codexPath:string}={selectedTask:null,selectedSession:null,drafts:{},pending:null,codexPath:''};
try{const saved=JSON.parse(localStorage.getItem(storeKey)||'null');if(saved?.drafts&&typeof saved.drafts==='object')local={...local,...saved};}catch{notice='Черновик не прочитан; исходные данные не перезаписаны.';}
function save(){try{localStorage.setItem(storeKey,JSON.stringify(local));}catch{throw Error('Не удалось сохранить локальное намерение. Отправка остановлена.');}}
function draftKey(){return task?task.id+':'+task.goalRevision:'new';}
function button(action:string,label:string,enabled=true,primary=false){return `<button class="button ${primary?'primary':''}" data-action="${action}" ${enabled&&(!busy||action==='interrupt')?'':'disabled'}>${label}</button>`;}
function message(text:string){notice=text;render();}
async function call<T>(op:string,p:Record<string,unknown>={}):Promise<T>{if(!service)throw Error('Нужна нативная сборка Studio. Браузерная страница не исполняет Codex.');return service.call<T>(op,p);}
function render(){
 const allowed=actionAvailability(session,commands,task?.goalRevision??0);
 if(local.pending){allowed.submit=false;allowed.steer=false;}
 const status=session?.status??'не подключено';
 $('app').innerHTML=`<div class="live-shell"><aside class="live-nav"><a class="brand" href="index.html">Слой <small>Platform Studio</small></a><div class="eyebrow">Помощник · Direct</div>
 <button class="button" data-action="new">＋ Новая задача</button><div class="live-projects">${tasks.map(t=>`<button class="nav-task ${task?.id===t.id?'active':''}" data-task="${esc(t.id)}">${esc(t.title)}</button>`).join('')||'<p class="muted">Задачи появятся после подключения к хосту.</p>'}</div>
 <a href="index.html">Канвас и встроенные операции ↗</a><a href="assistant-scenarios.html">Отдельный сценарный стенд ↗</a><p class="muted">Ни одно состояние здесь не получено из макета.</p></aside>
 <main id="main" class="live-main"><header class="live-top"><div><div class="eyebrow">${esc(task?.title||'Рабочее пространство')}</div><h1>${screen==='research'?'Ход исследования':screen==='observe'?'Наблюдение':screen==='history'?'Доставка и события':screen==='connections'?'Подключение':'Задача и сессия'}</h1></div><div class="badge">${esc(status)}</div></header>
 <nav class="live-tabs" aria-label="Представление работы">${[['work','Работа'],['research','Исследование'],['observe','Наблюдение'],['history','История'],['connections','Подключение']].map(([key,label])=>`<button data-screen="${key}" class="${screen===key?'active':''}">${label}</button>`).join('')}</nav>
 ${!service?'<div class="notice amber"><b>Открыта автономная страница, без нативного хоста.</b><p>Импорт журналов доступен. Сессии и команды не имитируются.</p></div>':''}
 ${notice?`<div role="status" class="notice">${esc(notice)}</div>`:''}
 ${screen==='research'?researchPanel():screen==='work'?work(allowed):screen==='observe'?observe():screen==='history'?history():connections()}
 </main></div>`;
}
function work(a:ReturnType<typeof actionAvailability>){
 if(!task)return `<section class="panel"><h2>Начать с реального проекта</h2><p>Каталог подключается ссылкой: репозиторий и двоичные файлы не загружаются в JSON.</p><label>Название<input id="task-title" value="${esc(local.drafts['new-title']||'')}" placeholder="Что нужно сделать"></label><label>Исходная цель<textarea id="goal" rows="5">${esc(local.drafts['new-goal']||'')}</textarea></label>
 <div class="toolbar">${button('folder','Выбрать папку',!!service)}<span class="muted">${esc(binding?.kind==='mounted'?binding.rootPath:'Папка не выбрана')}</span></div>${button('create','Создать задачу',!!binding&&!!service,true)}<p class="muted">Первый профиль — чтение через Codex. Сильная изоляция площадки и изменение оригинала не заявлены.</p></section>`;
 return `<div class="live-grid"><section class="stack"><article class="panel"><div class="row between"><h2>Исходная цель · v${task.goalRevision}</h2><span class="badge">${esc(task.binding.kind)}</span></div><p class="preserve">${esc(task.original)}</p><p class="muted path">${esc(task.binding.kind==='mounted'?task.binding.rootPath:'Текстовый снимок')}</p></article>
 <article class="panel"><h2>Поручение исполнителю</h2><p class="muted">Ввод отправляется как написан. Автоматический перевод и руководитель ещё не подключены.</p><textarea id="draft" rows="7" placeholder="Поручение или уточнение…">${esc(local.drafts[draftKey()]??task.original)}</textarea>
 <div class="toolbar">${button('send','Отправить новый ход',a.submit,true)}${button('steer','Уточнить текущий',a.steer)}${button('interrupt','Остановить',a.interrupt)}</div>
 <p class="muted">Адресат: ${esc(session?.externalThreadId||'не выбран')} · ${esc(session?.lastKnownTurnId||'без активного хода')}. Служебная метка команды добавляется явно; она не является гарантией провайдерской дедупликации.</p>
 ${a.uncertain?'<div class="notice amber">Предыдущая отправка ещё не разрешена. Новое поручение заблокировано; доступна сверка.</div>':''}
 ${local.pending?'<div class="notice amber">Есть локально сохранённая команда. Новая отправка не выполняется.<button class="button" data-action="recover-local">Прочитать состояние команды</button><button class="button" data-action="abandon-prepared">Снять только неотправленную команду</button></div>':''}</article>
 <article class="panel"><h2>Ответы исполнителя</h2><p class="muted">Заявления модели. Приёмка и проверка файлов в этом профиле пока недоступны.</p>${modelClaims(events).map(c=>`<div class="live-answer"><small>${esc(c.turnId)}</small><pre>${esc(c.text)}</pre></div>`).join('')||'<p class="muted">Подтверждённых сообщений пока нет.</p>'}</article></section>
 <aside class="stack"><section class="panel"><h2>Сессия</h2><label>Существующий thread ID <small>необязательно</small><input id="thread-id" placeholder="Пусто — создать новый"></label><div class="toolbar">${button('connect','Подключить / продолжить',!!service&&configured&&!local.pending&&(!session||['disconnected','state_unknown'].includes(session.status)))}${button('reconcile','Сверить',a.reconcile)}${button('disconnect','Отключить процесс',!!session)}</div><p class="muted">Закрытие окна не посылает отмену. После смерти хоста сессия сверяется, но ход не отправляется заново.</p></section>
 <section class="panel"><h2>Ограничения</h2><p>Codex Direct · read-only<br>Без автоматического расширения прав<br>Гарантии изолированной площадки: не приняты</p><p class="muted">Путь — рабочий каталог, а не граница безопасности. Пользовательские настройки Codex могут подключать hooks/MCP; их профиль нужно проверить перед работой.</p></section></aside></div>`;
}
function metrics(){return imported||window.DeskLiveEvents.analyzeEnvelopes(events,gap);}
function observe(){const m=metrics(),u=m.totals||{};return `<section class="panel"><div class="row between"><h2>${imported?'Выбранный журнал':'Наблюдаемые события сессии'}</h2>${button('import','Импорт JSONL',true)}${button('live','Вернуться к потоку',!!imported)}</div><div class="live-metrics">${[['input','Вход'],['cached','Кеш внутри входа'],['output','Выход'],['reasoning','Reasoning внутри выхода']].map(([key,name])=>`<div><strong>${u[key!]===null||u[key!]===undefined?'—':Number(u[key!]).toLocaleString('ru-RU')}</strong><span>${name}</span></div>`).join('')}</div><p>${esc(m.coverage)}</p>${(m.warnings||[]).map((x:string)=>`<p class="muted">${esc(x)}</p>`).join('')}<div class="live-table"><table><thead><tr><th>Ход</th><th>Состояние</th><th>Время хода*</th><th>Инструменты*</th><th>Явный TTFT</th></tr></thead><tbody>${(m.sessions||[]).flatMap((s:any)=>s.turns).map((t:any)=>`<tr><td>${esc(t.id)}</td><td>${esc(t.status)}</td><td>${esc(t.wallMs??'—')}</td><td>${esc(t.toolMs??'—')}</td><td>${esc(t.reportedTtftMs??'—')}</td></tr>`).join('')}</tbody></table></div><p class="muted">* мс; без собственного времени Codex это интервалы получения хостом. Повторы HTTP и очередь сервера неизвестны без отдельного источника. Токены не переводятся в цену подписки.</p></section>`;}
function history(){return `<section class="panel"><h2>Команды</h2><p>Принятие команды, выполнение хода и принятие результата — разные состояния. Здесь нет кнопки повтора неизвестного эффекта.</p><div class="live-table"><table><thead><tr><th>ID</th><th>Операция</th><th>Доставка</th><th>Основание</th></tr></thead><tbody>${commands.map(c=>`<tr><td>${esc(c.id)}</td><td>${esc(c.method)}</td><td>${esc(c.state)}</td><td>${esc(c.reason||c.remoteId||'—')}</td></tr>`).join('')}</tbody></table></div></section><section class="panel"><h2>Последние наблюдения</h2>${gap?'<p class="notice amber">Есть пробел истории; сохранённые дельты не выданы за полный журнал.</p>':''}<div class="timeline">${events.slice(-60).reverse().map(e=>`<div class="event"><div><strong>${esc(e.frame.method||'Ответ')}</strong><small>${esc(e.at)} · ${esc(e.origin)} · ${e.sequence}</small></div></div>`).join('')}</div></section>`;}
function connections(){return `<section class="panel"><h2>Codex Direct</h2><p>Используется установленный нативный Codex, без shell-обёртки и без скачивания. Открытие этой страницы не запускает его.</p><label>Исполняемый файл<input id="codex-path" value="${esc(local.codexPath)}" placeholder="C:\\…\\codex.exe"></label>${button('choose-exe','Выбрать codex.exe',!!service)}<label class="live-consent"><input type="checkbox" id="consent"> Разрешаю этот Direct-профиль: ограничения и права предоставляет настроенный Codex, не полная площадка Studio. Настройки hooks/MCP требуют собственной проверки.</label>${button('configure','Применить настройку',!!service,true)}<p class="muted">Изменение настроек Codex, авторизация, платные вызовы и запуск приложений автоматически не выполняются. Подключение треда — отдельное действие.</p><p>${configured?'Настройка принята хостом.':'Хост ещё не принял настройку.'}</p></section>`;}
function researchPanel(){return `<div class="toolbar">${button('research-refresh','Обновить из TaskStore',!!service&&!!task)}${button('research-import','Открыть контрольную точку',true)}</div>`+renderResearchTrace(research,researchOrigin,researchOrigin==='host'?task?.goalRevision:undefined);}
async function loadResearch(){if(!service||!task)return;const selected=task.id;const cp=await call<ResearchCheckpoint|null>('research_checkpoint',{taskId:selected});if(task?.id!==selected)return;research=cp?decodeResearchCheckpoint(JSON.stringify(cp)):null;researchOrigin='host';}
async function refresh(){if(!service||!session||polling)return;polling=true;const selected=session.id;try{
 const page=await call<{events:SessionEvent[];nextSequence:number;gap:boolean}>('codex_events',{sessionId:selected,afterSequence:cursor});
 if(session?.id!==selected)return;
 events=mergeEvents(events,page.events,selected);cursor=page.nextSequence;gap=gap||page.gap;
 const freshSession=await call<SessionRef>('codex_session',{sessionId:selected});const freshCommands=await call<ExternalIntent[]>('codex_commands',{sessionId:selected});if(session?.id!==selected)return;session=freshSession;commands=freshCommands;
 if(local.pending){const cid=local.pending.commandId;const known=commands.find(c=>c.id===cid);if(known&&['confirmed','rejected'].includes(known.state)){local.pending=null;save();}}
 // Streaming must not steal focus or destroy an in-progress textarea selection.
 if(screen==='research'&&researchOrigin==='host')await loadResearch();
 if(!['TEXTAREA','INPUT'].includes(document.activeElement?.tagName||'')&&!busy)render();
 }catch(e){notice='Нет свежего состояния хоста: '+String(e);if(!['TEXTAREA','INPUT'].includes(document.activeElement?.tagName||''))render();}finally{polling=false;}}
async function selectTask(t:Task){const selected=++selectionGeneration;research=null;researchOrigin='host';task=t;session=null;events=[];commands=[];cursor=0;gap=false;local.selectedTask=t.id;save();const list=await call<SessionRef[]>('task_sessions',{taskId:t.id});if(selected!==selectionGeneration)return;session=list.find(s=>s.id===local.selectedSession)||list.at(-1)||null;screen='work';render();await refresh();}
async function perform(action:string){
 if(action==='new'){selectionGeneration++;task=null;session=null;research=null;researchOrigin='host';screen='work';render();return;}
 if(action==='research-import'){($('import-research') as HTMLInputElement).click();return;}
 if(action==='import'){($('import-log') as HTMLInputElement).click();return;}
 if(action==='live'){imported=null;render();return;}
 const consentBefore=(document.querySelector('#consent') as HTMLInputElement|null)?.checked===true;
 const threadBefore=(document.querySelector('#thread-id') as HTMLInputElement|null)?.value.trim()||null;
 operationCount++;busy=true;render();try{
 if(action==='research-refresh'){await loadResearch();}
 if(action==='abandon-prepared'&&local.pending){await call('codex_abandon_prepared',{commandId:local.pending.commandId});local.pending=null;save();notice='Неотправленная команда закрыта. Её запоздалое поступление в хост не вызовет отправку.';}
 if(action==='recover-local'&&local.pending){const receipt=await call<ExternalIntent>('codex_command',{commandId:local.pending.commandId});commands=[receipt,...commands.filter(c=>c.id!==receipt.id)];if(['confirmed','rejected'].includes(receipt.state)){local.pending=null;save();}notice='Прочитана прежняя команда. Новых запросов к модели нет.';}
 if(action==='folder')binding=await service!.chooseWorkspace() as WorkspaceBinding|null;
 if(action==='choose-exe'){const path=await service!.chooseCodex();if(path)local.codexPath=path;save();}
 if(action==='configure'){if(!consentBefore)throw Error('Отметьте согласие с границами профиля.');await call('codex_configure',{executable:local.codexPath,acknowledgeDirectProfile:true});configured=true;notice='Настройка принята. Теперь можно подключить задачу.';}
 if(action==='create'){
  const title=local.drafts['new-title']?.trim()||'Новая задача',original=local.drafts['new-goal']?.trim();if(!original||!binding)throw Error('Нужны цель и папка.');
  const created=await call<Task>('task_create',{task:{id:id('task'),projectId:id('project'),title,original,binding}});tasks=[created,...tasks];await selectTask(created);
 }
 if(action==='connect'&&task){
  const external=threadBefore;
  const sid=session?.id||id('session'),commandId=id('command');
  local.pending={operation:'codex_open',commandId,sessionId:sid,taskId:task.id};local.selectedSession=sid;save();
  const result=await call<{session:SessionRef;command:ExternalIntent}>('codex_open',{taskId:task.id,sessionId:sid,commandId,externalThreadId:external});session=result.session;commands=[result.command];notice='Локальная команда сохранена. Итог доставки показан в истории.';if(result.command.state==='confirmed'){local.pending=null;save();const checked=await call<{session:SessionRef;commands:ExternalIntent[];notice:string}>('codex_reconcile',{sessionId:sid});session=checked.session;commands=checked.commands;notice=checked.notice;}
 }
 if(['send','steer'].includes(action)&&task&&session){
  const text=local.drafts[draftKey()]??task.original;if(!text.trim())throw Error('Поручение пустое.');const commandId=id('command');
  const operation=action==='steer'?'codex_steer':'codex_submit';const payload={sessionId:session.id,commandId,goalRevision:task.goalRevision,text,expectedTurnId:session.lastKnownTurnId};
  local.pending={operation,...payload};save();const receipt=await call<ExternalIntent>(operation,payload);commands=[receipt,...commands.filter(c=>c.id!==receipt.id)];
  if(receipt.state==='confirmed'){local.pending=null;local.drafts[draftKey()]='';save();}notice=receipt.state==='confirmed'?'Доставка подтверждена. Это ещё не проверенный результат.':'Исход показан в истории. Автоповтора нет.';
 }
 if(action==='interrupt'&&session){const commandId=id('command');const receipt=await call<ExternalIntent>('codex_interrupt',{sessionId:session.id,commandId,expectedTurnId:session.lastKnownTurnId});commands=[receipt,...commands];notice='Остановка запрошена. Дождитесь наблюдаемого завершения хода.';}
 if(action==='reconcile'&&session){const r=await call<{session:SessionRef;commands:ExternalIntent[];notice:string}>('codex_reconcile',{sessionId:session.id});session=r.session;commands=r.commands;notice=r.notice;}
 if(action==='disconnect'&&session){session=await call<SessionRef>('codex_disconnect',{sessionId:session.id});notice='Процесс отключён. Неизвестные внешние эффекты сохранены для сверки.';}
 }catch(e){notice=String(e);}finally{if(task&&!session&&service){const selected=task.id;try{const known=await call<SessionRef[]>('task_sessions',{taskId:selected});if(task?.id===selected)session=known.find(s=>s.id===local.selectedSession)||null;}catch{ /* The original failure stays visible. */ }}operationCount--;busy=operationCount>0;render();await refresh();}
}
document.addEventListener('click',e=>{const target=e.target as HTMLElement;const nav=target.closest<HTMLElement>('[data-screen]');if(nav&&!busy){screen=nav.dataset.screen!;render();if(screen==='research'&&researchOrigin==='host')void loadResearch().then(()=>{if(screen==='research')render();}).catch(e=>message(String(e)));return;}const selected=target.closest<HTMLElement>('[data-task]');if(selected&&!busy){const t=tasks.find(t=>t.id===selected.dataset.task);if(t)void selectTask(t).catch(e=>message(String(e)));return;}const b=target.closest<HTMLButtonElement>('[data-action]');if(b&&!b.disabled)void perform(b.dataset.action!);});
document.addEventListener('input',e=>{const t=e.target as HTMLInputElement|HTMLTextAreaElement;if(t.id==='draft')local.drafts[draftKey()]=t.value;else if(t.id==='goal')local.drafts['new-goal']=t.value;else if(t.id==='task-title')local.drafts['new-title']=t.value;else if(t.id==='codex-path')local.codexPath=t.value;else return;try{save();}catch(e){notice=String(e);}});
$('import-log').addEventListener('change',async e=>{const input=e.target as HTMLInputElement;const f=input.files?.[0];if(!f)return;try{if(f.size>64*1024*1024)throw Error('Предел файла — 64 МиБ');const p=window.CodexTelemetry.parseText(await f.text(),'selected-file');imported=window.CodexTelemetry.analyze(p.events,p.warnings);screen='observe';render();}catch(e){message(String(e));}input.value='';});
$('import-research').addEventListener('change',async e=>{const input=e.target as HTMLInputElement;const f=input.files?.[0];if(!f)return;try{if(f.size>524288)throw Error('Предел — 512 КиБ');research=decodeResearchCheckpoint(await f.text());researchOrigin='import';screen='research';render();}catch(e){message(String(e));}input.value='';});
async function boot(){render();if(!service)return;try{const c=await service.capabilities();if(!c.codexDirect)throw Error('Хост 0.2 не поддерживает профиль. Требуется новая нативная сборка.');tasks=await call<Task[]>('tasks_list');const selected=tasks.find(t=>t.id===local.selectedTask)||tasks[0];if(selected)await selectTask(selected);else render();}catch(e){message(String(e));}}
void boot();setInterval(()=>void refresh(),750);
