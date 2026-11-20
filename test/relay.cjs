process.env.IGOR_IP_SESSIONS='0';process.env.IGOR_IP_SOCKETS='0';
const {createServer}=require('../server.cjs');
const {WebSocket}=require('ws');
const assert=require('node:assert/strict');
const s=createServer();
const live=new Set();
function peer(url, origin, join){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(url,{origin});live.add(ws);
  ws.on('error',reject);
  const waiters=[];
  const seen=[];
  ws.on('close',()=>live.delete(ws));
  ws.on('open',()=>ws.send(JSON.stringify({type:'join',...join})));
  const take=(type, check=()=>true)=>{
   const i=seen.findIndex(m=>m.type===type&&check(m));
   if(i>=0)return Promise.resolve(seen.splice(i,1)[0]);
   return new Promise((done,fail)=>{
    const timeout=setTimeout(()=>fail(new Error('Timeout: '+type)),3000);
    waiters.push({type,check,done:m=>{clearTimeout(timeout);done(m);}});
   });
  };
  ws.on('message',data=>{
   const m=JSON.parse(data);
   const i=waiters.findIndex(w=>w.type===m.type&&w.check(m));
   if(i>=0)waiters.splice(i,1)[0].done(m);
   else seen.push(m);
  });
  take('ready').then(auth=>resolve({ws,auth,take,send:m=>ws.send(JSON.stringify(m))}),reject);
 });
}
(async()=>{
 try {
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const host='127.0.0.1:'+s.address().port;
  const origin='http://'+host;
  const url='ws://'+host+'/sync';
  const newSession=async()=> (await fetch(origin+'/api/new',{method:'POST'})).json();
  const add=async()=>{
   const session=await newSession();
   assert.match(session.code,/^[A-Z2-9]{5}$/);
   const [a,b]=await Promise.all([peer(url,origin,{...session,role:'screen'}),peer(url,origin,{code:session.code,role:'viewer'})]);
   await Promise.all([a.take('peer',m=>m.online),b.take('peer',m=>m.online)]);
   return [a,b];
  };
  const pairs=[];
  const mark=()=>Math.round(process.memoryUsage().rss/1048576);
  console.log('RSS initial',mark(),'MiB (Windows, clients and server in same process)');
  for(let batch=0;batch<12;batch++) pairs.push(...await Promise.all(Array.from({length:25},add)));
  console.log('Paired',pairs.length,'groups');
  const [screen,operator]=pairs[0];
  operator.send({type:'control', displaySize:{width:1280,height:720}});
  assert.deepEqual((await screen.take('control')).displaySize,{width:1280,height:720});
  screen.send({type:'signal',description:{type:'offer',sdp:'relay-test'}});
  assert.equal((await operator.take('signal')).description.sdp,'relay-test');
  screen.send({type:'state',content:{text:'test 🟡'}});
  assert.equal((await operator.take('state')).content.text,'test 🟡');
  operator.send({type:'control',command:'play'});
  assert.equal((await screen.take('control')).command,'play');
  screen.send({type:'edit-result',ok:true});
  assert.equal((await operator.take('edit-result')).ok,true);
  await Promise.all(pairs.map(async ([a,b],index)=>{
   a.send({type:'state',state:{offset:index},content:{text:'a'.repeat(12000)}});
   assert.equal((await b.take('state')).state.offset,index);
  }));
  operator.ws.close();
  await screen.take('peer',m=>!m.online);
  const rejoined=await peer(url,origin,{role:'viewer',id:operator.auth.id,viewerKey:operator.auth.viewerKey});
  await screen.take('peer',m=>m.online);
  rejoined.send({type:'control',displaySize:{width:1024,height:768}});
  assert.equal((await screen.take('control')).displaySize.width,1024);
  console.log('Forwarding, signalling and disconnect passed for 300 pairs.');
 } finally {
  for(const ws of live)ws.terminate();
  s.closeAllConnections();
  s.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

