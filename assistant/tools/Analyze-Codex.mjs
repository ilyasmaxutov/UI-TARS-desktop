// Optional CLI analyzer. The HTML and PowerShell collector do not require Node.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const T=require('../src/telemetry.js');
const args=process.argv.slice(2),files=[];let output=null;
for(let i=0;i<args.length;i++){if(args[i]==='--output'){output=args[++i];if(!output)throw new Error('--output requires a path');}else files.push(args[i]);}
if(!files.length){console.error('Usage: node tools/Analyze-Codex.mjs <rollout.jsonl|capture.json> [...] --output report.json');process.exit(2);}
try{
 const events=[],warnings=[];let bytes=0;
 for(let i=0;i<files.length;i++){const st=await stat(files[i]);if(st.size>64*1024*1024||(bytes+=st.size)>128*1024*1024)throw new Error('Import limit: 64 MiB/file, 128 MiB total.');
 const p=T.parseText(await readFile(files[i],'utf8'),'input-'+i);events.push(...p.events);warnings.push(...p.warnings);if(events.length>200000)throw new Error('Event limit: 200000.');}
 const result=T.analyze(events,warnings),json=JSON.stringify(result,null,2);
 if(output){await writeFile(output,json,{flag:'wx'});console.log(JSON.stringify({output,sessions:result.sessions.length,events:result.eventCount,coverage:result.coverage}));}
 else process.stdout.write(json+'\n');
}catch(e){console.error(e.message);process.exit(1);}
