import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let html=await readFile(path.join(root,'src/template.html'),'utf8');
for(const [mark,file]of [['CSS','style.css'],['CORE','core.js'],['TELEMETRY','telemetry.js'],['UI','ui.js']]){
 const data=await readFile(path.join(root,'src',file),'utf8');
 html=html.replace(`/*__${mark}__*/`,()=>data.replace(/<\/script/gi,'<\\/script'));
}
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,'dist/Assistant_Desk.html'),html);
console.log('Built offline HTML:',Buffer.byteLength(html),'bytes');
