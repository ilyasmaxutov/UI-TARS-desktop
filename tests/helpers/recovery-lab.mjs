/** Development-only test components. NOT a production native host or Windows sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonical } from '../../build/core/model.js';
import { execute } from '../../build/core/runtime.js';
const root=new URL('../../',import.meta.url);
export const v1=fs.readFileSync(new URL('native/crates/core/src/schema/v1.sql',root),'utf8');
export const v2=fs.readFileSync(new URL('native/crates/core/src/schema/v2.sql',root),'utf8');
export function openDatabase(file=':memory:'){
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
 try{db.exec(v1);db.exec(v2);db.exec('PRAGMA user_version=2; COMMIT;');}catch(e){db.exec('ROLLBACK');db.close();throw e;}
 return db;
}
function atomicWrite(file,value){
 const temp=file+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);
 if (process.platform !== 'win32') { const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);} }
}
export class FileIntentRepository{
 constructor(root){this.root=root;fs.mkdirSync(root,{recursive:true});}
 file(id){if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('ID');return path.join(this.root,id+'.json');}
 async get(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async list(){return fs.readdirSync(this.root).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(this.root,x),'utf8')));}
 async insert(intent){if(fs.existsSync(this.file(intent.id)))throw Error('conflict');atomicWrite(this.file(intent.id),structuredClone(intent));}
 async replace(intent,expected){const old=await this.get(intent.id);if(!old||old.revision!==expected||old.fingerprint!==intent.fingerprint)throw Error('OUTBOX_CONFLICT');atomicWrite(this.file(intent.id),intent);}
}
export class SqlLabReceiver{
 // Reuses production SQL and TypeScript built-ins; Rust callbacks / IPC are NOT exercised.
 constructor(file){this.db=openDatabase(file);this.deliveries=0;}
 async capabilities(){return {protocol:2,durableCommands:true};}
 async lookup(commandId){const row=this.db.prepare('SELECT runs.payload FROM commands JOIN runs ON runs.id=commands.run_id WHERE commands.id=?').get(commandId);return row?JSON.parse(row.payload):null;}
 async start(commandId,document,files){
  this.deliveries++;const prior=await this.lookup(commandId);if(prior)return prior;
  const run=await execute(document,files,{profile:'native-builtins'}),spec=canonical({document,files});
  run.commandFingerprint=createHash('sha256').update(spec).digest('hex');
  this.db.exec('BEGIN IMMEDIATE;');try{
   const prior=await this.lookup(commandId);if(prior){this.db.exec('ROLLBACK');return prior;}
   this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.id,run.state,spec,JSON.stringify(run),run.startedAt);
   this.db.prepare('INSERT INTO run_controls(run_id) VALUES(?)').run(run.id);
   this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(commandId,createHash('sha256').update(spec).digest('hex'),run.id);
   this.db.exec('COMMIT;');return run;
  }catch(e){this.db.exec('ROLLBACK;');throw e;}
 }
 close(){this.db.close();}
}
