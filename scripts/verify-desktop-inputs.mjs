import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export function verifyDesktopInputs(root) {
  const configPath=join(root,'native/crates/desktop/tauri.conf.json');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(config.version!==pkg.version)throw Error('Desktop version differs from package version.');
  const window=config.app.windows.find(w=>w.label==='main');
  if(window?.url!=='assistant.html')throw Error('The native window must open the host-backed assistant, not the canvas or scenarios.');
  const dist=resolve(root,'native/crates/desktop',config.build.frontendDist);
  const rel=relative(root,dist);
  if(isAbsolute(rel)||rel.startsWith('..'))throw Error('Frontend directory escapes the source tree.');
  for(const name of ['assistant.html','index.html','worker.js','assistant-scenarios.html']) {
    if(!existsSync(join(dist,name)))throw Error(`Missing generated frontend: ${name}. Build it before Cargo.`);
    const text=readFileSync(join(dist,name),'utf8');
    if(!text.length||/\/\* (LIVE_APP|STUDIO_JS|TELEMETRY|DESK_CSS) \*\//.test(text))throw Error(`Unbuilt frontend: ${name}`);
  }
  return {version:pkg.version,entrypoint:window.url,frontendFiles:4,guiExecuted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(verifyDesktopInputs(resolve(import.meta.dirname,'..'))));}catch(e){console.error(e.message);process.exitCode=1;}}
