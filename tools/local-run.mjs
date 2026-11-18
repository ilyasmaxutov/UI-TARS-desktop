// CLI verification/development route. Node is not required by the offline HTML or native target.
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createDocument} from '../build/core/graph.js';
import {execute,validateArtifact} from '../build/core/runtime.js';
import {LIMITS,safePath,validateFiles} from '../build/core/model.js';
export async function readTextTree(input){
 const root=await fs.realpath(input),files=[];let total=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 async function visit(folder,depth=0){if(depth>32)throw new Error('DEPTH: maximum directory depth exceeded');
  for(const e of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(folder,e.name),before=await fs.lstat(filename);
   if(before.isSymbolicLink())throw new Error('LINK: '+filename);if(before.isDirectory()){await visit(filename,depth+1);continue;}
   if(!before.isFile())throw new Error('FORMAT: '+filename);if(files.length>=LIMITS.files||before.size>LIMITS.fileBytes||total+before.size>LIMITS.totalBytes)throw new Error('LIMIT: input set exceeds profile');
   const relative=safePath(path.relative(root,filename).split(path.sep).join('/'));
   const handle=await fs.open(filename,'r');let buffer;try{const stat=await handle.stat();if(stat.size>LIMITS.fileBytes)throw new Error('LIMIT: file grew');buffer=Buffer.alloc(Math.min(LIMITS.fileBytes+1,stat.size+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);buffer=buffer.subarray(0,bytesRead);}finally{await handle.close();}
   const after=await fs.lstat(filename);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.isSymbolicLink()||buffer.length!==before.size)throw new Error('SOURCE_CHANGED: '+relative);
   total+=buffer.length;files.push({path:relative,content:decoder.decode(buffer)});
  }
 }
 await visit(root);validateFiles(files);return files;
}
export async function runLocal({input,output,template='report'}){
 if(!['report','normalize'].includes(template))throw new Error('Only report and normalize are enabled in this CLI');
 const root=await fs.realpath(input);const parent=await fs.realpath(path.dirname(path.resolve(output)));const destination=path.join(parent,path.basename(output));
 const rel=path.relative(root,destination);if(!rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))throw new Error('OUTPUT: proposal must be outside source tree');
 const files=await readTextTree(root);const document=createDocument('cli-project','CLI · '+template,template);const run=await execute(document,files);
 if(run.state!=='review'||!run.artifacts[0]||!await validateArtifact(run.artifacts[0]))throw new Error(run.error??'No verified artifact');
 const artifact=run.artifacts[0];if(artifact.files.some(f=>f.path==='.studio-manifest.json'))throw new Error('Reserved export manifest name');
 await fs.mkdir(destination); // Exclusive directory creation: no overwrite, including an earlier failed export.
 for(const f of artifact.files){const target=path.join(destination,...safePath(f.path).split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,f.content,{flag:'wx',encoding:'utf8'});if(await fs.readFile(target,'utf8')!==f.content)throw new Error('READBACK: '+f.path);}
 await fs.writeFile(path.join(destination,'.studio-manifest.json'),JSON.stringify({artifact,runId:run.id,originalModified:false,acceptedByOwner:false},null,2),{flag:'wx'});
 return {runId:run.id,state:run.state,path:destination,artifactHash:artifact.hash,files:artifact.files.length,originalModified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--input','--output','--template'].includes(args[i])||!args[i+1])throw new Error('Usage: node tools/local-run.mjs --input DIR --output NEW_DIR [--template report|normalize]');options[args[i].slice(2)]=args[i+1];}
 if(!options.input||!options.output)throw new Error('--input and --output are required');console.log(JSON.stringify(await runLocal(options),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
