/** Synthetic peer ONLY. Does not call Codex, an account, network, shell, or a model. */
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=process.argv[2],fault=process.argv[3]||'normal';if(!root)throw Error('test directory required');
const stateFile=path.join(root,'remote.json');let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{threadId:'fixture-thread',turns:[],mutations:0};
function save(){const file=fs.openSync(stateFile,'w');try{fs.writeFileSync(file,JSON.stringify(state));fs.fsyncSync(file);}finally{fs.closeSync(file);}}
function send(x){process.stdout.write(JSON.stringify(x)+'\n');}
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialized')return;
 if(r.method==='initialize'){send({id:r.id,result:{userAgent:'SYNTHETIC-PEER/1'}});return;}
 if(r.method==='thread/read'){send({id:r.id,result:{thread:{id:state.threadId,status:{type:'idle'}}}});return;}
 if(r.method==='thread/turns/list'){send({id:r.id,result:{data:state.turns,nextCursor:null}});return;}
 if(r.method==='turn/start'){
  state.mutations++;const turn={id:'fixture-turn-'+state.mutations,status:'completed',items:[{type:'userMessage',id:'user-'+state.mutations,content:r.params.input}]};state.turns.push(turn);save();
  if(fault==='after-accept-before-ack')process.exit(91);
  send({method:'turn/started',params:{threadId:state.threadId,turn:{...turn,status:'inProgress'}}});
  send({method:'turn/completed',params:{threadId:state.threadId,turn}});
  send({id:r.id,result:{turn}});return;
 }
 send({id:r.id,error:{code:-32601,message:'Fixture method not implemented'}});
});
