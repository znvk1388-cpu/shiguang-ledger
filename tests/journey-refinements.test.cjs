const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {JSDOM}=require('jsdom')
const turn=()=>new Promise(resolve=>setImmediate(resolve))
async function setup(){
 const dom=new JSDOM('<main id="mainView"><button id="opener">记一笔</button><div id="content"></div></main><section id="authView" inert></section><div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>',{url:'https://ledger.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,errors=[]
 w.addEventListener('error',e=>{errors.push(e.message);e.preventDefault()})
 const account={id:1,name:'现金',currency:'CNY'},cat={id:1,name:'餐饮',txn_type:'expense'}
 w.eval(fs.readFileSync('js/format.js','utf8'));w.TXN_TYPE_LABEL={expense:'支出',income:'收入',transfer:'转账'}
 w.DB={mode:'guest',state:{sourceId:'isolated',categories:[cat]},activeBookId:()=>1,accounts:()=>[account],allAccounts:()=>[account],category:()=>cat,rootCategories:()=>[cat],childCategories:()=>[],categoryName:()=>cat.name,accountName:()=>account.name,budgetOf:()=>null,listRecurring:async()=>[],listAttachments:async()=>({}),listTransactions:async()=>({rows:[{id:1,txn_type:'expense',amount:12.5,account_id:1,category_id:1,note:'午餐',occurred_at:'2026-11-11T04:00:00Z'}],total:1}),addTransaction:async()=>{throw Error('网络失败')}}
 w.Lazy={need:async name=>name==='smart'?{noteSuggestions:async()=>['餐'.repeat(75)]}:null}
 const state={tab:'home',homeView:'list',scope:'month',year:2026,month:11,filters:{type:'',accountId:null,keyword:'',tag:'',minAmount:'',maxAmount:''},loaded:100}
 w.App={state,refresh:async()=>{},bindContentEvents(){}}
 w.localStorage.setItem('ledger10_home_budget','off');w.confirm=()=>true
 w.eval(fs.readFileSync('js/ui.js','utf8'))
 return {w,dom,state,errors,$:s=>w.document.querySelector(s),close:()=>w.close()}
}
test('sheet isolates the background, keeps it isolated on replacement and restores only owned inert state',async()=>{
 const h=await setup();try{
  h.$('#opener').focus();h.w.UI.openSheet('<b class="sheet-title">一个面板</b>')
  assert.equal(h.$('#mainView').hasAttribute('inert'),true);assert.equal(h.$('#authView').hasAttribute('inert'),true)
  h.w.UI.openSheet('<b class="sheet-title">替换内容</b>');assert.equal(h.$('#mainView').hasAttribute('inert'),true)
  h.w.UI.closeSheet();assert.equal(h.$('#mainView').hasAttribute('inert'),false);assert.equal(h.$('#authView').hasAttribute('inert'),true)
  assert.equal(h.w.document.activeElement.id,'opener')
 }finally{h.close()}
})
test('failed saves have a persistent footer alert and retry clears the previous failure',async()=>{
 const h=await setup();try{
  await h.w.UI.openEditor(null);h.$('#amtInput').value='8.90';h.$('#noteInput').value='咖啡';h.$('#edSave').click();await turn()
  assert.match(h.$('#edErr').textContent,/保存失败/);assert.ok(h.$('#edErr').closest('.sheet-foot'));assert.equal(h.$('#amtInput').value,'8.90')
  let resolve;h.w.DB.addTransaction=()=>new Promise(done=>{resolve=done});h.$('#edSave').click();assert.equal(h.$('#edErr').textContent,'');assert.equal(h.$('#edSave').disabled,true)
  resolve({id:2});await turn();assert.equal(h.$('#sheet').getAttribute('aria-hidden'),'true')
 }finally{h.close()}
})
test('common-note reuse updates the remaining count without throwing or losing the amount',async()=>{
 const h=await setup();try{
  await h.w.UI.openEditor(null);await turn();await turn();h.$('#amtInput').value='18'
  const suggestion=h.$('#noteSug [data-note]');assert.ok(suggestion);suggestion.click()
  assert.equal(h.$('#noteInput').value,'餐'.repeat(75));assert.match(h.$('#noteLimit').textContent,/5/)
  assert.equal(h.$('#amtInput').value,'18');assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('touch-tablet amount focus opens the keypad without waiting for another click',async()=>{
 const h=await setup();try{
  h.w.matchMedia=()=>({matches:true});Object.defineProperty(h.w,'innerWidth',{value:834,configurable:true});await h.w.UI.openEditor(null)
  h.$('#amtInput').focus();assert.equal(h.$('#keypadWrap').classList.contains('hidden'),false)
 }finally{h.close()}
})
test('filter redraw keeps the latest filter focus and selected semantics',async()=>{
 const h=await setup();try{
  await h.w.UI.renderHome(h.state);h.$('[data-ftype="expense"]').focus();h.state.filters.type='expense';await h.w.UI.renderHome(h.state)
  assert.equal(h.w.document.activeElement.dataset.ftype,'expense');assert.equal(h.$('[data-ftype="expense"]').getAttribute('aria-pressed'),'true');assert.equal(h.$('[data-ftype=""]').getAttribute('aria-pressed'),'false')
  h.$('[data-ftype="expense"]').focus();const original=h.w.DB.listTransactions;let release;h.w.DB.listTransactions=()=>new Promise(done=>{release=done});const refresh=h.w.UI.renderHome(h.state);await turn();h.$('#opener').focus();release(await original());await refresh
  assert.equal(h.w.document.activeElement.id,'opener','异步结果不能抢走外部焦点')
 }finally{h.close()}
})
