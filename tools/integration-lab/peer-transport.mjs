/** Test driver, not a second production runtime. Production transport is Rust codex/peer.rs. */
import {spawn} from 'node:child_process';import readline from 'node:readline';import {fileURLToPath} from 'node:url';
export class FixturePeer {
 constructor(root,fault='normal'){
  this.events=[];this.next=0;this.pending=new Map();this.exit=null;
  this.child=spawn(process.execPath,[fileURLToPath(new URL('./mock-codex.cjs',import.meta.url)),root,fault],{stdio:['pipe','pipe','pipe']});
  const reader=readline.createInterface({input:this.child.stdout});reader.on('line',line=>{const frame=JSON.parse(line);if(frame.method){this.events.push(frame);return;}const waiter=this.pending.get(frame.id);if(waiter){this.pending.delete(frame.id);clearTimeout(waiter.timer);frame.error?waiter.reject(Error(frame.error.message)):waiter.resolve(frame.result);}});
  this.child.on('exit',(code)=>{this.exit=code;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('fixture exited '+code));}this.pending.clear();});
  this.child.on('error',e=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();});
 }
 call(method,params={}){const id=String(++this.next);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('test deadline'));},2500);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
 async initialize(){await this.call('initialize',{clientInfo:{name:'fixture-client',version:'1'}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}
 async close(){if(this.exit!==null)return;await new Promise(r=>{this.child.once('exit',r);this.child.kill();});}
}
