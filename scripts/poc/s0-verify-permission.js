// scripts/poc/s0-verify-permission.js — 验证权限轴能读不能写（S0 第四轮）。
//
// 第一性原理：为什么这条需要单独一个探针
//
//   D8 原本设计了一个权限下拉，前提假设是官方应该能让我们设置权限。
//   这个假设从未被验证过，而它决定了 UI 该做开关还是只读展示 ——
//   两者对用户是完全不同的承诺。
//
//   探针回答三个问题：
//     1. 能不能读当前档位？        （能 -> 右栏可以显示风险）
//     2. 能不能列可选档位？        （能 -> 可以告诉用户系统支持哪几档）
//     3. 能不能写？                （决定 UI 是否有开关）
//
//   第 3 条的权威依据不是我没找到，而是
//   dsh-permission-presets/lib/typert.host.js 里**只注册了 catalog** 一个方法。
//   所以本脚本除了跑 RPC，也会把那个生成文件的方法清单打出来。
//
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = process.argv[2];
const REPO = '/Users/xia/program/dsh/DshCockpit';
const env = () => ({ ...process.env, DSH_HOME: path.join(ROOT,'dsh-home'), DSH_POC_ISOLATED:'1', npm_config_cache: path.join(ROOT,'npm-cache'), DSH_PRIMARY_RUNTIME: path.join(ROOT,'dsh-home') });
function get(url, headers={}) { return new Promise(res=>{ const r=http.get(url,{headers},(s)=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>res({status:s.statusCode,headers:s.headers,body:b}));}); r.on('error',e=>res({status:0,headers:{},body:String(e.message)})); r.setTimeout(20000,()=>{r.destroy();res({status:0,headers:{},body:'timeout'});}); }); }
function boot(bin) { return new Promise(res=>{ const c=spawn(process.execPath,[bin,'--profile','web','--port','0','--no-open'],{env:env(),stdio:['ignore','pipe','pipe']}); let buf=''; let done=false; const t=setTimeout(()=>{if(!done){done=true;try{c.kill('SIGKILL')}catch{}res({error:'timeout'})}},90000); const on=d=>{buf+=String(d);const m=buf.match(/https?:\/\/[^\s"']+/);if(m&&!done){done=true;clearTimeout(t);res({url:m[0],child:c});}}; c.stdout.on('data',on); c.stderr.on('data',on); c.on('exit',code=>{if(!done){done=true;clearTimeout(t);res({error:'exit '+code})}}); }); }
(async()=>{
  const bin = path.join(ROOT,'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const b = await boot(bin);
  if (b.error) { console.log('BOOT FAIL', b.error); process.exit(1); }
  const res = await get(b.url);
  const sc = res.headers['set-cookie'];
  const cookie = (Array.isArray(sc)?sc:[sc]).map(c=>String(c).split(';')[0]).join('; ');
  const { createRuntimeMux } = require(path.join(REPO,'src/runtime-mux.js'));
  const origin = new URL(b.url).origin;
  const mux = await new Promise((resolve,reject)=>{ const m=createRuntimeMux({baseUrl:origin,auth:{getCookie:async()=>cookie,invalidate(){}},log(){},onError(){}}); const t=setTimeout(()=>reject(new Error('mux timeout')),25000); m.onReady(()=>{clearTimeout(t);resolve(m)}); m.connect(); });
  // 试 permissionPresets/catalog
  for (const [method,args] of [
    ['permissionPresets/catalog', {}],
    ['permissionPresets/catalog', { _request: {} }],
  ]) {
    try {
      const r = await mux.call(method, args);
      console.log(method, JSON.stringify(args), '->', JSON.stringify(r).slice(0,400));
    } catch (e) { console.log(method, JSON.stringify(args), '-> ERR:', String(e.message).slice(0,200)); }
  }
  // 建会话后读 permissions 投影
  const created = await mux.call('session/create',{request:{cwd:path.join(ROOT,'workspace')}});
  const sid = (created.value||created).sessionId;
  const proj = await mux.call('session/projections',{request:{sessionId:sid}});
  const values = (proj.value||proj).values||{};
  console.log('permissions projection:', JSON.stringify(values.permissions));
  try{mux.close()}catch{}; try{b.child.kill()}catch{}; process.exit(0);
})().catch(e=>{console.log('FATAL',e.message);process.exit(1)});
