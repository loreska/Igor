const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const {handleRequest} = require('../server.cjs');
async function request(url, method='GET') {
 let size = 0;
 const response = new Writable({write(chunk, _, next) {size += chunk.length; next();}});
 response.headers = {};
 response.setHeader = (name,value) => {response.headers[name]=value;};
 response.writeHead = (status, headers) => {response.status=status; Object.assign(response.headers,headers);};
 const req = {url, method, async *[Symbol.asyncIterator]() {yield '{}';}};
 await handleRequest(req,response);
 return {status:response.status, headers:response.headers, size};
}
(async()=>{
 const page=await request('/');
 assert.equal(page.status,200);
 assert.equal(page.headers['Cross-Origin-Opener-Policy'],'same-origin');
 assert.equal(page.headers['Cross-Origin-Embedder-Policy'],'require-corp');
 for (const item of ['dist/browser.js','dist/browser.worker.global.js','wasm/soffice.js','wasm/soffice.worker.js','wasm/soffice.wasm','wasm/soffice.data']) {
   const result=await request('/office-2.7.2/'+item);
   assert.equal(result.status,200,item);
   assert.equal(result.size,result.headers['Content-Length']);
   assert.match(result.headers['Cache-Control'],/immutable/);
   if(item.endsWith('.wasm')) assert.equal(result.headers['Content-Type'],'application/wasm');
 }
 assert.notEqual((await request('/api/convert-pptx','POST')).status,200);
 console.log('Isolation headers, six actual converter assets, cache directives, and removed server conversion verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});

