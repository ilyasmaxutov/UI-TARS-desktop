// CLI-only fault injection. Exit after receiver commit, before caller sees a receipt.
import { FileIntentRepository, SqlLabReceiver } from './recovery-lab.mjs';
import { StartOutbox } from '../../build/core/outbox.js';
import path from 'node:path';
const [root,commandId]=process.argv.slice(2);
const receiver=new SqlLabReceiver(path.join(root,'receiver.sqlite3'));
const outbox=new StartOutbox(new FileIntentRepository(path.join(root,'outbox')),{capabilities:()=>receiver.capabilities(),lookup:id=>receiver.lookup(id),start:async(...args)=>{await receiver.start(...args);process.exit(91);}});
await outbox.send(commandId);
throw Error('Crash point was not reached');
