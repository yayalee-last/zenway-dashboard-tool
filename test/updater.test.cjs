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
const {Updater,DEFAULT_API}=require('../electron/updater');
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
async function downloadServer(t, mode = 'body') {
  const root = temporary(t);
  const payload = Buffer.from('complete update archive');
  let behavior = mode, entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const server = http.createServer((_req, res) => {
    entered();
    if (behavior === 'headers') return;
    if (behavior === 'error') { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Length': payload.length });
    if (behavior === 'body') { res.write(payload.subarray(0, 3)); return; }
    if (behavior === 'slow') {
      let index = 0;
      const timer = setInterval(() => {
        res.write(payload.subarray(index, ++index));
        if (index === payload.length) { clearInterval(timer); res.end(); }
      }, 30);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const asset = { name: APP_ARCHIVE, kind: 'app', size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    url: `http://127.0.0.1:${server.address().port}/download` };
  const updater = new Updater({ currentVersion: '0.0.0', stateDir: root, appDir: path.join(root, 'installed') });
  return { updater, asset, payload, requested,
    complete() { behavior = 'complete'; },
    assertNoArchive() {
      assert.equal(fs.existsSync(path.join(root, 'updates', APP_ARCHIVE)), false);
      assert.equal(fs.existsSync(path.join(root, 'updates', APP_ARCHIVE + '.part')), false);
    },
  };
}

for (const phase of ['headers', 'body']) {
  test('download times out while waiting for ' + phase + ' and can retry', { timeout: 3000 }, async t => {
    const f = await downloadServer(t, phase);
    await assert.rejects(f.updater.download(f.asset, null, { timeoutMs: 150 }), /下载.*超时/);
    f.assertNoArchive();
    f.complete();
    const result = await f.updater.download(f.asset);
    assert.deepEqual(fs.readFileSync(result.zipPath), f.payload);
  });

  test('manual cancellation interrupts ' + phase + ' and permits a fresh download', { timeout: 3000 }, async t => {
    const f = await downloadServer(t, phase);
    const controller = new AbortController();
    let received;
    const progress = new Promise(resolve => { received = resolve; });
    const pending = f.updater.download(f.asset, received, { signal: controller.signal });
    const rejected = assert.rejects(pending, /已取消更新下载/);
    await (phase === 'body' ? progress : f.requested);
    controller.abort(new Error('已取消更新下载'));
    await rejected;
    f.assertNoArchive();
    f.complete();
    assert.deepEqual(fs.readFileSync((await f.updater.download(f.asset)).zipPath), f.payload);
  });
}

test('ongoing progress refreshes the download timeout', { timeout: 4000 }, async t => {
  const f = await downloadServer(t, 'slow');
  const result = await f.updater.download(f.asset, null, { timeoutMs: 250 });
  assert.deepEqual(fs.readFileSync(result.zipPath), f.payload);
});

test('HTTP download failures leave the same asset retryable', async t => {
  const f = await downloadServer(t, 'error');
  await assert.rejects(f.updater.download(f.asset), /HTTP 503/);
  f.assertNoArchive();
  f.complete();
  assert.deepEqual(fs.readFileSync((await f.updater.download(f.asset)).zipPath), f.payload);
});

test('cancellation at final progress cannot save or install the archive', async t => {
  const f = await downloadServer(t, 'complete');
  const controller = new AbortController();
  await assert.rejects(f.updater.download(f.asset, () => {
    controller.abort(new Error('已取消更新下载'));
  }, { signal: controller.signal }), /已取消更新下载/);
  f.assertNoArchive();
});

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

const PROXY = 'https://gh-proxy.com/';
const RELEASE_BASE = 'https://github.com/yayalee-last/zenway-dashboard-tool/releases/download/v' + version + '/';

function proxyFixture(t, respond) {
  const root = temporary(t), requests = [];
  const payload = Buffer.from('verified proxy update archive');
  const digest = createHash('sha256').update(payload).digest('hex');
  const release = { tag_name: 'v' + version, assets: [
    { name: 'ZentaoWidget-win32-x64.zip', size: 123456, browser_download_url: RELEASE_BASE + 'ZentaoWidget-win32-x64.zip' },
    { name: APP_ARCHIVE, size: payload.length, digest: 'sha256:' + digest, browser_download_url: RELEASE_BASE + APP_ARCHIVE },
    { name: UPDATE_MANIFEST, browser_download_url: RELEASE_BASE + UPDATE_MANIFEST },
  ] };
  const manifest = { schemaVersion: UPDATE_SCHEMA, version, electronVersion,
    platform: process.platform, arch: process.arch, asset: APP_ARCHIVE, size: payload.length, sha256: digest };
  const reply = url => url.endsWith('/latest') ? Response.json(release)
    : url.endsWith(UPDATE_MANIFEST) ? Response.json(manifest) : new Response(payload);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return respond(String(url), options, reply);
  });
  const updater = new Updater({ currentVersion: '0.0.0', stateDir: root, appDir: path.join(root, 'installed') });
  return { updater, requests, release, payload, manifest,
    asset: { name: APP_ARCHIVE, url: RELEASE_BASE + APP_ARCHIVE, size: payload.length, sha256: digest, kind: 'app' },
    noArchive() { assert.equal(fs.existsSync(path.join(root, 'updates', APP_ARCHIVE)), false); },
  };
}

test('public proxy covers release checks, metadata and verified application downloads', async t => {
  const f = proxyFixture(t, (url, _options, reply) => {
    if (!url.startsWith(PROXY)) throw new TypeError('Direct connection unavailable');
    return reply(url);
  });
  const checked = await f.updater.check();
  assert.equal(checked.ok, true);
  assert.equal(checked.asset.kind, 'app');
  const result = await f.updater.download(checked.asset);
  assert.deepEqual(fs.readFileSync(result.zipPath), f.payload);
  assert.deepEqual(f.requests.map(r => r.url), [
    DEFAULT_API, PROXY + DEFAULT_API,
    RELEASE_BASE + UPDATE_MANIFEST, PROXY + RELEASE_BASE + UPDATE_MANIFEST,
    RELEASE_BASE + APP_ARCHIVE, PROXY + RELEASE_BASE + APP_ARCHIVE,
  ]);
  for (const { options } of f.requests) {
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.deepEqual(Object.keys(options.headers).filter(key => /authorization|token|cookie/i.test(key)), []);
  }
});

test('successful public GitHub requests do not use the proxy', async t => {
  const f = proxyFixture(t, (url, _options, reply) => {
    assert.equal(url.startsWith(PROXY), false);
    return reply(url);
  });
  await f.updater.download((await f.updater.check()).asset);
  assert.equal(f.requests.length, 3);
});

for (const status of [403, 429, 503]) {
  test('public proxy is tried once after GitHub HTTP ' + status, async t => {
    const f = proxyFixture(t, (url, _options, reply) =>
      url === DEFAULT_API ? new Response('{}', { status }) : reply(url));
    assert.equal((await f.updater.check()).ok, true);
    assert.deepEqual(f.requests.slice(0, 2).map(r => r.url), [DEFAULT_API, PROXY + DEFAULT_API]);
  });
}

test('public proxy gets a fresh timeout budget after direct API timeout', async t => {
  const f = proxyFixture(t, (url, { signal }, reply) => {
    if (url !== DEFAULT_API) return reply(url);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  assert.equal((await f.updater.check({ timeoutMs: 25 })).ok, true);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.requests[1].options.signal.aborted, false);
});

test('public proxy recovers an intercepted JSON response and unavailable metadata', async t => {
  const f = proxyFixture(t, (url, _options, reply) => {
    if (url === DEFAULT_API) return new Response('<html>Network interception</html>');
    if (url === RELEASE_BASE + UPDATE_MANIFEST) throw new TypeError('Metadata unavailable directly');
    return reply(url);
  });
  assert.equal((await f.updater.check()).asset.kind, 'app');
  assert.equal(f.requests.length, 4);
});

test('public proxy recovers an archive that stalls after some bytes', async t => {
  const f = proxyFixture(t, (url, { signal }, reply) => {
    if (url.startsWith(PROXY)) return reply(url);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('part'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }), { headers: { 'Content-Length': f.payload.length } });
  });
  const result = await f.updater.download(f.asset, null, { timeoutMs: 25 });
  assert.deepEqual(fs.readFileSync(result.zipPath), f.payload);
  assert.equal(f.requests.length, 2);
});

for (const proxyCorrupt of [false, true]) {
  test('public proxy archive is independently checked: corrupt=' + proxyCorrupt, async t => {
    const f = proxyFixture(t, (url, _options, reply) =>
      !url.startsWith(PROXY) || proxyCorrupt ? new Response(Buffer.alloc(f.payload.length)) : reply(url));
    if (proxyCorrupt) {
      await assert.rejects(f.updater.download(f.asset), /校验失败/);
      f.noArchive();
    } else {
      const result = await f.updater.download(f.asset);
      assert.deepEqual(fs.readFileSync(result.zipPath), f.payload);
    }
    assert.equal(f.requests.length, 2);
  });
}

test('manual cancellation must not start a public proxy request', async t => {
  let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const f = proxyFixture(t, (_url, { signal }) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const rejected = assert.rejects(f.updater.download(f.asset, null, { signal: controller.signal }), /已取消更新下载/);
  await requested;
  controller.abort(new Error('已取消更新下载'));
  await rejected;
  assert.equal(f.requests.length, 1);
  f.noArchive();
});

test('manual cancellation also interrupts the active public proxy stream', async t => {
  const f = proxyFixture(t, (url, _options, reply) => {
    if (!url.startsWith(PROXY)) throw new TypeError('Direct connection unavailable');
    return reply(url);
  });
  const controller = new AbortController();
  await assert.rejects(f.updater.download(f.asset, () => {
    controller.abort(new Error('已取消更新下载'));
  }, { signal: controller.signal }), /已取消更新下载/);
  assert.equal(f.requests.length, 2);
  f.noArchive();
});

test('HTTP 404 remains a release or asset error without a proxy retry', async t => {
  const f = proxyFixture(t, () => new Response('{}', { status: 404 }));
  const checked = await f.updater.check();
  assert.equal(checked.ok, false);
  assert.equal(checked.hint, 'private-or-empty');
  await assert.rejects(f.updater.download(f.asset), /HTTP 404/);
  assert.equal(f.requests.length, 2);
});

for (const url of [
  'https://github.com/another/private/releases/download/v1/ZentaoWidget-app.zip',
  'https://api.github.com/repos/another/private/releases/latest',
  RELEASE_BASE + APP_ARCHIVE + '?access_token=fixture-only',
  'http://127.0.0.1:1/private.zip',
]) {
  test('custom or private update addresses are never sent to the public proxy: ' + url, async t => {
    const f = proxyFixture(t, () => { throw new TypeError('Offline'); });
    await assert.rejects(f.updater.download({ ...f.asset, url }), /Offline/);
    assert.deepEqual(f.requests.map(r => r.url), [url]);
  });
}

test('failure of both GitHub and public proxy is reported without an archive', async t => {
  const f = proxyFixture(t, () => { throw new TypeError('All update routes unavailable'); });
  const checked = await f.updater.check();
  assert.equal(checked.ok, false);
  assert.match(checked.error, /All update routes unavailable/);
  await assert.rejects(f.updater.download(f.asset), /All update routes unavailable/);
  assert.equal(f.requests.length, 4);
  f.noArchive();
});


test('full archives also fall back to the public proxy and retain digest verification', async t => {
  const f = proxyFixture(t, (url, _options, reply) => {
    if (url === RELEASE_BASE + 'ZentaoWidget-win32-x64.zip') throw new TypeError('Direct archive unavailable');
    return reply(url);
  });
  f.manifest.electronVersion = '0.0.1';
  Object.assign(f.release.assets[0], { size: f.payload.length, digest: 'sha256:' + f.asset.sha256 });
  const checked = await f.updater.check();
  assert.equal(checked.asset.kind, 'full');
  const downloaded = await f.updater.download(checked.asset);
  assert.deepEqual(fs.readFileSync(downloaded.zipPath), f.payload);
  assert.equal(f.requests.at(-1).url, PROXY + RELEASE_BASE + 'ZentaoWidget-win32-x64.zip');
});
