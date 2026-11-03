// scripts/poc/s0-verify-changes.js — 验证文件变更清单的读取路径（S0 第二轮）。
//
// 第一性原理：为什么清单不在事件里
//
//   workspace/changes 事件的 payload **只有 {turn}**（读官方源码确认）。
//   文件清单留在 Host 端的 TurnRecorder，按事件的 seq 索引，
//   客户端通过两个认证路由读取：
//     GET /api/changes.summary?sessionId=&seq=    -> {turn, files[], total, added, deleted}
//     GET /api/changes.diff?sessionId=&seq=&index= -> 单文件 unified diff
//
//   这决定了 S5 的凭证设计：凭证坐标是 {sessionRef, seq}，
//   不是我们自己算的文件指纹 —— 自建就成了第二个事实作者。
//
//   限制：清单仅保留到 Session dispose，Host 重启后 404。
//   所以凭证必须 turn 结束后立即落盘。
//
// 验证 /api/changes.summary 能否用我们壳的 cookie 调用（S5 前置）。
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = process.argv[2];
const REPO = '/Users/xia/program/dsh/DshCockpit';
function env() { return { ...process.env, DSH_HOME: path.join(ROOT,'dsh-home'), DSH_POC_ISOLATED:'1', npm_config_cache: path.join(ROOT,'npm-cache'), DSH_PRIMARY_RUNTIME: path.join(ROOT,'dsh-home') }; }
function get(url, headers={}) { return new Promise(res=>{ const r=http.get(url,{headers},(s)=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>res({status:s.statusCode,headers:s.headers,body:b}));}); r.on('error',e=>res({status:0,headers:{},body:String(e.message)})); r.setTimeout(20000,()=>{r.destroy();res({status:0,headers:{},body:'timeout'});}); }); }
function boot(bin) { return new Promise(res=>{ const c=spawn(process.execPath,[bin,'--profile','web','--port','0','--no-open'],{env:env(),stdio:['ignore','pipe','pipe']}); let buf=''; let done=false; const t=setTimeout(()=>{if(!done){done=true;try{c.kill('SIGKILL')}catch{}res({error:'timeout'})}},90000); const on=d=>{buf+=String(d);const m=buf.match(/https?:\/\/[^\s"']+/);if(m&&!done){done=true;clearTimeout(t);res({url:m[0],child:c});}}; c.stdout.on('data',on); c.stderr.on('data',on); c.on('exit',code=>{if(!done){done=true;clearTimeout(t);res({error:'exit '+code+': '+buf.slice(0,300)})}}); }); }

(async()=>{
  const bin = path.join(ROOT,'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!fs.existsSync(bin)) { console.log('NO BIN'); process.exit(1); }
  const b = await boot(bin);
  if (b.error) { console.log('BOOT FAIL', b.error); process.exit(1); }
  const res = await get(b.url);
  const sc = res.headers['set-cookie'];
  const cookie = (Array.isArray(sc)?sc:[sc]).map(c=>String(c).split(';')[0]).join('; ');
  const { createRuntimeMux } = require(path.join(REPO,'src/runtime-mux.js'));
  const origin = new URL(b.url).origin;
  const mux = await new Promise((resolve,reject)=>{
    const m = createRuntimeMux({baseUrl:origin, auth:{getCookie:async()=>cookie,invalidate(){}}, log(){}, onError(){}});
    const t=setTimeout(()=>reject(new Error('mux timeout')),25000);
    m.onReady(()=>{clearTimeout(t);resolve(m)});
    m.connect();
  });
  const created = await mux.call('session/create',{request:{cwd:path.join(ROOT,'workspace')}});
  const sid = (created.value||created).sessionId;
  console.log('session:', String(sid).slice(0,14)+'…');
  // 让模型真的改一个文件 → 产生 workspace/changes
  await mux.call('session/prompt',{request:{requestId:crypto.randomUUID(),sessionId:sid,mode:'queue',
    content:[{type:'text',text:'请立即执行这条 shell 命令，不要做别的：echo hello-s5 > probe-s5.txt && ls -la probe-s5.txt 。执行完把命令输出原样告诉我。'}]}});
  // 轮询 follow 事件，找 workspace/changes 的 seq
  const seq = await new Promise(async(resolve)=>{
    const streamId='f-'+crypto.randomUUID();
    const t=setTimeout(()=>{try{mux.closeStream(streamId)}catch{}resolve(null)},180000);
    const seen=new Set();
    mux.onItem(streamId,(item)=>{
      if(item && item.type==='event' && item.event){
        seen.add(item.event.type);
        if(item.event.type==='workspace/changes'){
          clearTimeout(t); const s=item.event.seq; try{mux.closeStream(streamId)}catch{} resolve({seq:s,seen:[...seen]});
        }
      }
    });
    mux.openStream(streamId,'session/follow',{request:{address:{kind:'session',sessionId:sid}}});
  });
  console.log('workspace/changes:', JSON.stringify(seq));
  // 调 summary 路由
  const url = `${origin}/api/changes.summary?sessionId=${encodeURIComponent(sid)}&seq=${seq&&seq.seq!=null?seq.seq:0}`;
  const sres = await get(url,{cookie});
  console.log('changes.summary status:', sres.status);
  console.log('body:', String(sres.body).slice(0,500));
  try{mux.close()}catch{}
  try{b.child.kill()}catch{}
  process.exit(0);
})().catch(e=>{console.log('FATAL',e.message);process.exit(1)});
