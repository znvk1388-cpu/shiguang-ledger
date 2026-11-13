const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');const turn=()=>new Promise(r=>setImmediate(r));
function setup(){
 const source=fs.readFileSync('js/app.js','utf8'),a=source.indexOf('  let tabMotionVersion'),b=source.indexOf('  function shiftPeriod',a),pending=[],scrolls=[];
 assert.ok(a>=0&&b>a);const state={tab:'home'},context={state,UI:{animateFeedback(){}},window:{scrollTo:(...args)=>scrolls.push(args)},$:()=>({}),$$:()=>[],refresh:()=>new Promise(resolve=>pending.push(resolve))};
 vm.runInNewContext(source.slice(a,b)+'\nglobalThis.navigate=setTab',context);return{navigate:context.navigate,state,pending,scrolls};
}
test('a repeated click during the same navigation retains its pending reset and only the latest render moves scroll',async()=>{
 const h=setup();h.navigate('me');h.navigate('me');h.pending[0]();await turn();assert.equal(h.scrolls.length,0);h.pending[1]();await turn();assert.equal(h.scrolls.length,1);assert.deepEqual(h.scrolls[0],[0,0]);h.navigate('me');h.pending[2]();await turn();assert.equal(h.scrolls.length,1,'a refresh of the settled tab preserves scroll');
});
test('rapid navigation resets only the final tab after its render completes',async()=>{
 const h=setup();h.navigate('me');h.navigate('stats');h.pending[1]();await turn();assert.equal(h.scrolls.length,1);h.pending[0]();await turn();assert.equal(h.scrolls.length,1);assert.equal(h.state.tab,'stats');
});
