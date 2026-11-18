import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';
const sql=fs.readFileSync(new URL('../../native/crates/core/src/schema/v3.sql',import.meta.url),'utf8');
/** Actual v3 SQL with a test-only JS repository facade. Rust Store is NOT exercised. */
export class SqlRepository {
 constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;');this.db.exec(sql);
  this.db.prepare('INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run('task','project','Protocol lab',1,'Synthetic protocol test','{}','{}','now','now');
  this.db.prepare('INSERT OR IGNORE INTO executor_sessions(id,task_id,profile_kind,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('session','task','codex-direct','g','idle','now','now');}
 async insert(c){this.db.prepare('INSERT INTO external_commands(id,session_id,task_id,goal_revision,generation,method,params_json,fingerprint,expected_thread_id,expected_turn_id,marker,exact_input,state,revision,attempts,remote_id,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(c.id,c.sessionId,c.taskId,c.goalRevision,c.generation,c.method,JSON.stringify(c.params),c.fingerprint,c.expectedThreadId,c.expectedTurnId,c.marker,c.exactInput,c.state,c.revision,c.attempts,c.remoteId,c.reason,'now','now');}
 async get(id){const r=this.db.prepare('SELECT * FROM external_commands WHERE id=?').get(id);return r?{id:r.id,taskId:r.task_id,sessionId:r.session_id,goalRevision:r.goal_revision,generation:r.generation,method:r.method,params:JSON.parse(r.params_json),fingerprint:r.fingerprint,expectedThreadId:r.expected_thread_id,expectedTurnId:r.expected_turn_id,marker:r.marker,exactInput:r.exact_input,state:r.state,revision:r.revision,attempts:r.attempts,remoteId:r.remote_id,reason:r.reason}:null;}
 async replace(c,rev){const x=this.db.prepare('UPDATE external_commands SET state=?,revision=?,attempts=?,remote_id=?,reason=? WHERE id=? AND revision=?').run(c.state,c.revision,c.attempts,c.remoteId,c.reason,c.id,rev);if(x.changes!==1)throw Error('CAS failed');}
 close(){this.db.close();}
}
