import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function verifyDelivery(directory) {
 const manifest=JSON.parse(readFileSync(join(directory,'DELIVERY.json'),'utf8').replace(/^\uFEFF/,''));
 if(manifest.schema!==1||manifest.target!=='windows-x64'||manifest.frontend!=='assistant.html')throw Error('Unexpected delivery contract.');
 const names=['studio-desktop.exe','studio-host.exe','studio-economy.exe'];
 if(!Array.isArray(manifest.files)||manifest.files.length!==names.length)throw Error('Incomplete desktop/host/helper package.');
 if(new Set(manifest.files.map(f=>f.name)).size!==names.length)throw Error('Duplicate delivery member.');
 for(const name of names){
  const entry=manifest.files.find(f=>f.name===name);if(!entry)throw Error(`Missing ${name}`);
  const file=join(directory,name),size=statSync(file).size;
  if(size<64||size>512*1024*1024||entry.bytes!==size)throw Error(`Invalid size: ${name}`);
  const bytes=readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
  if(hash!==entry.sha256)throw Error(`Hash mismatch: ${name}`);
  const offset=bytes.readUInt32LE(0x3c);
  if(bytes[0]!==0x4d||bytes[1]!==0x5a||offset<64||offset+6>bytes.length||bytes.toString('latin1',offset,offset+4)!=='PE\x00\x00'||bytes.readUInt16LE(offset+4)!==0x8664)throw Error(`Not an x64 PE executable: ${name}`);
 }
 return {schema:1,verifiedFiles:names.length,byteIntegrity:true,executed:false,claims:manifest.claims};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{if(process.argv.length!==3)throw Error('Usage: node scripts/verify-delivery.mjs <directory>');console.log(JSON.stringify(verifyDelivery(resolve(process.argv[2]))));}catch(e){console.error(e.message);process.exitCode=1;}}
