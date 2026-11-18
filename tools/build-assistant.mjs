import fs from 'node:fs';
import path from 'node:path';
import { bundle } from './bundle.mjs';
const root=path.resolve(import.meta.dirname,'..');
let html=fs.readFileSync(path.join(root,'public/assistant.html'),'utf8');
for(const[marker,file]of [['DESK_CSS','assistant/src/style.css'],['TELEMETRY','assistant/src/telemetry.js'],['LIVE_ADAPTER','assistant/src/live-events.js']])
 html=html.replace(`/* ${marker} */`,()=>fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script'));
html=html.replace('/* LIVE_APP */',()=>bundle('assistant/app.js').replace(/<\/script/gi,'<\\/script'));
fs.mkdirSync(path.join(root,'dist'),{recursive:true});fs.writeFileSync(path.join(root,'dist/assistant.html'),html);
// Scenarios are preserved for regression work and explicitly separate from the live host-backed UI.
let scenario=fs.readFileSync(path.join(root,'assistant/src/template.html'),'utf8');
for(const[marker,file]of [['CSS','style.css'],['CORE','core.js'],['TELEMETRY','telemetry.js'],['UI','ui.js']])scenario=scenario.replace(`/*__${marker}__*/`,()=>fs.readFileSync(path.join(root,'assistant/src',file),'utf8').replace(/<\/script/gi,'<\\/script'));
fs.writeFileSync(path.join(root,'dist/assistant-scenarios.html'),scenario);
console.log(`Built host-backed assistant (${Buffer.byteLength(html)} bytes); scenario UI is a separate file.`);
