'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const {Updater}=require('../electron/updater');
const {APP_ARCHIVE,UPDATE_MANIFEST,UPDATE_SCHEMA}=require('../electron/update-format');
const version=require('../package.json').version;
const electronVersion=require('electron/package.json').version;
const originalElectron=Object.getOwnPropertyDescriptor(process.versions,'electron');
before(()=>Object.defineProperty(process.versions,'electron',{value:electronVersion,configurable:true}));
after(()=>{if(originalElectron)Object.defineProperty(process.versions,'electron',originalElectron);else delete process.versions.electron;});

function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zentao-update-test-'));t.after(()=>fs.promises.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100}));return dir;}
function writeApp(dir,appVersion=version){fs.mkdirSync(path.join(dir,'electron'),{recursive:true});fs.mkdirSync(path.join(dir,'renderer'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'zentao-widget',version:appVersion,main:'electron/main.js'}));fs.writeFileSync(path.join(dir,'electron','main.js'),'// fixture');fs.writeFileSync(path.join(dir,'renderer','index.html'),'<title>fixture</title>');}
async function fixtureServer(t,options={}){
 const payload=Buffer.from('application archive fixture');const root=temporary(t);const requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/latest'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(release));}else if(req.url==='/manifest'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));}else if(req.url==='/app'){res.end(options.corrupt?Buffer.from('corrupted archive fixture'):payload);}else{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const assets=[{name:'ZentaoWidget-win32-x64.zip',size:99999,browser_download_url:base+'/full'}];
 if(!options.legacy)assets.push({name:APP_ARCHIVE,size:payload.length,browser_download_url:base+'/app'},{name:UPDATE_MANIFEST,browser_download_url:base+'/manifest'});
 const release={tag_name:`v${version}`,assets};
 const manifest={schemaVersion:UPDATE_SCHEMA,version,electronVersion,platform:process.platform,arch:process.arch,asset:APP_ARCHIVE,size:payload.length,sha256:createHash('sha256').update(payload).digest('hex'),...options.manifest};
 return {updater:new Updater({currentVersion:'0.0.0',apiUrl:base+'/latest',stateDir:root,appDir:path.join(root,'installed'),exeName:'ZentaoWidget.exe'}),requests,payload,root};
}

test('compatible runtime downloads only the verified application archive',async t=>{
 const f=await fixtureServer(t);const result=await f.updater.check();assert.equal(result.ok,true);assert.equal(result.asset.kind,'app');const download=await f.updater.download(result.asset);assert.deepEqual(fs.readFileSync(download.zipPath),f.payload);assert.deepEqual(f.requests,['/latest','/manifest','/app']);
});
test('runtime changes use the full package',async t=>{const f=await fixtureServer(t,{manifest:{electronVersion:'0.0.1'}});assert.equal((await f.updater.check()).asset.kind,'full');});
test('mismatched release metadata falls back to the full package',async t=>{const f=await fixtureServer(t,{manifest:{version:'0.0.1'}});assert.equal((await f.updater.check()).asset.kind,'full');});
test('legacy releases remain installable as full packages',async t=>{const f=await fixtureServer(t,{legacy:true});const result=await f.updater.check();assert.equal(result.ok,true);assert.equal(result.asset.kind,'full');assert.equal(result.asset.name,'ZentaoWidget-win32-x64.zip');});
test('corrupt application archives are rejected before installation',async t=>{const f=await fixtureServer(t,{corrupt:true});const result=await f.updater.check();await assert.rejects(f.updater.download(result.asset),/校验失败|下载不完整/);assert.equal(fs.existsSync(path.join(f.root,'updates',APP_ARCHIVE)),false);});

async function zipFolder(from,dest,name){const {ZipArchive}=await import('archiver');await new Promise((resolve,reject)=>{const output=fs.createWriteStream(dest);const archive=new ZipArchive();output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.pipe(output);archive.directory(from,name);archive.finalize().catch(reject);});}
function windowsFixture(t){const root=temporary(t);const installed=path.join(root,'installed');writeApp(path.join(installed,'resources','app'),'0.0.0');fs.writeFileSync(path.join(installed,'resources','app','obsolete.txt'),'old');fs.copyFileSync(path.join(process.env.SystemRoot,'System32','where.exe'),path.join(installed,'ZentaoWidget.exe'));fs.writeFileSync(path.join(installed,'runtime-marker'),'unchanged runtime');const stateDir=path.join(root,'state');fs.mkdirSync(stateDir);fs.writeFileSync(path.join(stateDir,'config.json'),'{"account":"keep"}');return {root,installed,stateDir,updater:new Updater({currentVersion:'0.0.0',stateDir,appDir:installed,exeName:'ZentaoWidget.exe'})};}
async function runHelper(script){return execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script.file],{windowsHide:true,timeout:15000,env:{...process.env,...script.env}});}
async function awaitLog(file,phrase){const until=Date.now()+15000;while(Date.now()<until){if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(phrase))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Background update did not complete: '+(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'no log'));}

test('background app update survives launcher exit and preserves runtime and user settings',{skip:process.platform!=='win32'},async t=>{
 const f=windowsFixture(t);const source=path.join(f.root,'source');writeApp(source);const archive=path.join(f.root,'app.zip');await zipFolder(source,archive,'app');const {script}=await f.updater.install(archive,`v${version}`,{kind:'app'});
 assert.equal(script.env.ZT_TARGET,path.join(f.installed,'resources','app'));
 const launcher=path.join(f.root,'launcher.cjs');fs.writeFileSync(launcher,`const {Updater}=require(${JSON.stringify(require.resolve('../electron/updater'))});const u=new Updater(${JSON.stringify({stateDir:f.stateDir,appDir:f.installed,exeName:'ZentaoWidget.exe'})});const s=${JSON.stringify(script)};s.env.ZT_PARENT_PID=String(process.pid);u.launchApply(s).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});`);
 await execFileAsync(process.execPath,[launcher],{windowsHide:true,timeout:10000});await awaitLog(script.env.ZT_LOG,'Update applied successfully.');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed,'resources','app','package.json'))).version,version);assert.equal(fs.existsSync(path.join(f.installed,'resources','app','obsolete.txt')),false);assert.equal(fs.readFileSync(path.join(f.installed,'runtime-marker'),'utf8'),'unchanged runtime');assert.equal(fs.readFileSync(path.join(f.stateDir,'config.json'),'utf8'),'{"account":"keep"}');
});
test('full update replaces its directory with the compatible legacy layout',{skip:process.platform!=='win32'},async t=>{
 const f=windowsFixture(t);const source=path.join(f.root,'full-source');writeApp(path.join(source,'resources','app'));fs.copyFileSync(path.join(process.env.SystemRoot,'System32','where.exe'),path.join(source,'ZentaoWidget.exe'));fs.writeFileSync(path.join(source,'runtime-marker'),'new runtime');const archive=path.join(f.root,'full.zip');await zipFolder(source,archive,'ZentaoWidget-win32-x64');const {script}=await f.updater.install(archive,`v${version}`,{kind:'full'});script.env.ZT_PARENT_PID='2147483647';await runHelper(script);assert.equal(fs.readFileSync(path.join(f.installed,'runtime-marker'),'utf8'),'new runtime');assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed,'resources','app','package.json'))).version,version);
});
test('failed relaunch restores the previous application directory',{skip:process.platform!=='win32'},async t=>{
 const f=windowsFixture(t);const source=path.join(f.root,'source');writeApp(source);const script=f.updater.writeApplyScript(source,f.installed,'missing.exe',true);script.env.ZT_PARENT_PID='2147483647';await assert.rejects(runHelper(script));assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed,'resources','app','package.json'))).version,'0.0.0');assert(fs.readFileSync(script.env.ZT_LOG,'utf8').includes('Previous version restored.'));
});
test('process wait has a deadline and leaves the installed app untouched',{skip:process.platform!=='win32'},async t=>{
 const f=windowsFixture(t);const source=path.join(f.root,'source');writeApp(source);const script=f.updater.writeApplyScript(source,f.installed,'ZentaoWidget.exe',true);const helper=fs.readFileSync(script.file,'utf8');assert(helper.includes('WaitForExit(30000)'));fs.writeFileSync(script.file,helper.replace('WaitForExit(30000)','WaitForExit(100)'));await assert.rejects(runHelper(script));assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed,'resources','app','package.json'))).version,'0.0.0');assert(fs.readFileSync(script.env.ZT_LOG,'utf8').includes('Timed out waiting'));
});
test('wrong application versions are rejected before replacement',{skip:process.platform!=='win32'},async t=>{const f=windowsFixture(t);const source=path.join(f.root,'source');writeApp(source,'0.0.1');const archive=path.join(f.root,'wrong.zip');await zipFolder(source,archive,'app');await assert.rejects(f.updater.install(archive,`v${version}`,{kind:'app'}),/版本不匹配/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed,'resources','app','package.json'))).version,'0.0.0');});
