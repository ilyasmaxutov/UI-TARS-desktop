// Dependency-free production bundler for our restricted static ES module subset.
// Build tooling only: no dev server, browser, shell executor or remote asset.
import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
export function bundle(entry){const visited=new Set();const chunks=[];
 function walk(name){if(visited.has(name))return;visited.add(name);const source=fs.readFileSync(path.join(root,'build',name),'utf8');let code=source;const imports=[];
  const re=/import\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"];?/g;for(const match of source.matchAll(re)){const dep=path.posix.normalize(path.posix.join(path.posix.dirname(name),match[2]));walk(dep);imports.push({full:match[0],dep,bindings:match[1].replace(/\bas\b/g,':')});}
  for(const i of imports)code=code.replace(i.full,`const {${i.bindings}} = __modules[${JSON.stringify(i.dep)}];`);
  const exports=[];code=code.replace(/export\s+(async\s+)?(function|class|const|let|var)\s+(\w+)/g,(_,a,b,c)=>{exports.push(c);return (a??'')+b+' '+c;});
  code=code.replace(/export\s*\{\s*\};?/g,'');
  if(/^\s*(import|export)\b/m.test(code))throw new Error('Unsupported module syntax in '+name);
  chunks.push(`__modules[${JSON.stringify(name)}] = (() => {\n${code}\nreturn {${exports.join(',')}};\n})();`);
 }
 walk(entry);return `(()=>{'use strict';const __modules=Object.create(null);\n${chunks.join('\n')}\n})();`;
}
const worker=bundle('ui/worker.js');const app=`window.__STUDIO_WORKER__=${JSON.stringify(worker)};\n${bundle('ui/app.js')}`;
const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');const template=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
const html=template.replace('/* STUDIO_CSS */',()=>css).replace('/* STUDIO_JS */',()=>app.replace(/<\/script/gi,'<\\/script'));
fs.writeFileSync(path.join(root,'dist/index.html'),html);fs.writeFileSync(path.join(root,'dist/worker.js'),worker);
console.log(`Built offline HTML (${Buffer.byteLength(html)} bytes), ${visitedCount(app)} module factories. No application was launched.`);
function visitedCount(s){return (s.match(/= \(\(\) => \{/g)||[]).length;}
