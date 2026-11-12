const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');const turn=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const dom=new JSDOM('<main id="mainView"><button id="opener">打开</button><div id="content"></div></main><div id="authView"></div><div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>',{url:'https://ledger.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.eval(fs.readFileSync('js/format.js','utf8'));w.TXN_TYPE_LABEL={expense:'支出',income:'收入',transfer:'转账'};w.confirm=()=>true;w.Lazy={need:async()=>null};
 const accounts=[{id:1,name:'人民币',currency:'CNY'},{id:2,name:'人民币储蓄',currency:'CNY'},{id:3,name:'美元',currency:'USD'}],cats=[{id:10,name:'餐饮',kind:'expense'},{id:11,name:'交通',kind:'expense'},{id:12,name:'工资',kind:'income'}];
 const rows=[{id:1,txn_type:'expense',amount:100,account_id:1,category_id:10,note:'午餐',occurred_at:'2026-11-12T04:00:00Z'},{id:2,txn_type:'income',amount:300,account_id:1,category_id:12,note:'收入',occurred_at:'2026-11-12T04:00:00Z'},{id:3,txn_type:'transfer',amount:25,account_id:1,to_account_id:2,note:'转账',occurred_at:'2026-11-12T04:00:00Z'}];
 let book=1;const writes=[];
 w.DB={mode:'guest',state:{sourceId:'unit',categories:cats},activeBookId:()=>book,accounts:()=>accounts,allAccounts:()=>accounts,category:id=>cats.find(c=>c.id===id),rootCategories:kind=>cats.filter(c=>c.kind===kind),childCategories:()=>[],categoryName:id=>cats.find(c=>c.id===id)?.name||'',accountName:id=>accounts.find(a=>a.id===id)?.name||'',budgetOf:()=>null,listRecurring:async()=>[],listTemplates:async()=>[],listAttachments:async()=>({}),listTransactions:async()=>({rows,total:rows.length}),getTransaction:async id=>rows.find(t=>t.id===id),updateTransaction:async(id,p)=>{writes.push({id,p});Object.assign(rows.find(t=>t.id===id),p)},deleteTransaction:async()=>{}};
 const state={tab:'home',homeView:'list',scope:'month',year:2026,month:11,loaded:100,filters:{type:'',accountId:null,keyword:'',tag:'',minAmount:'',maxAmount:''},attachments:{}};
 w.App={state,refresh:async()=>{},bindContentEvents(){}};w.localStorage.setItem('ledger10_home_budget','off');w.eval(fs.readFileSync('js/ui.js','utf8'));
 const $=s=>w.document.querySelector(s);const batch=async(ids=[1])=>{await w.UI.renderHome(state);$('[data-batch]').click();for(const id of ids)$('#content .txn[data-id="'+id+'"]').click()};
 return{dom,w,$,state,rows,accounts,writes,batch,setBook:n=>book=n,close:()=>w.close()};
}
test('delete confirmation cancel preserves the original editor nodes and unsaved input',async()=>{
 const h=await setup();try{await h.w.UI.openEditor(h.rows[0]);const input=h.$('#noteInput');input.value='尚未保存';h.$('#edDelete').click();h.$('#cfNo').click();await turn();assert.equal(h.$('#noteInput'),input);assert.equal(input.value,'尚未保存');assert.equal(h.$('#sheet').getAttribute('aria-hidden'),'false')}finally{h.close()}
});
test('all confirmation dismissal paths settle false and preserve parent focus and inert ownership',async()=>{
 for(const kind of ['escape','mask','closeSheet','replace']){
 const h=await setup();try{
 h.w.UI.openSheet('<input id="parentInput" value="keep"><button id="parentButton">父面板</button>');h.$('#parentButton').focus();
 const bar=h.w.document.createElement('div');bar.id='batchBar';bar.innerHTML='<button>后台</button>';h.w.document.body.appendChild(bar);
 let settled=false,value;h.w.UI.confirmSheet('确认').then(v=>{settled=true;value=v});await turn();
 assert.ok(bar.hasAttribute('inert'),'动态body工具栏也应隔离');
 if(kind==='escape')h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 else if(kind==='mask')h.$('#confirmLayer').click();
 else if(kind==='replace')h.w.UI.openSheet('<b class="sheet-title">其他面板</b>');
 else h.w.UI.closeSheet();
 await turn();assert.equal(settled,true,kind);assert.equal(value,false,kind);
 if(kind!=='replace'){assert.equal(h.$('#parentInput').value,'keep');assert.equal(h.w.document.activeElement.id,'parentButton')}
 assert.equal(bar.hasAttribute('inert'),false);
 }finally{h.close()}}
});
test('batch account picker disables cross-currency and transfer-to-self destinations',async()=>{
 const h=await setup();try{await h.batch([1]);h.$('#batchAcc').click();assert.equal(h.$('[data-bacc="3"]').disabled,true);h.w.UI.closeSheet();h.$('#batchExit').click();await h.batch([3]);h.$('#batchAcc').click();assert.equal(h.$('[data-bacc="2"]').disabled,true)}finally{h.close()}
});
test('batch category choices match selected transaction types and mixed selection cannot apply one category',async()=>{
 const h=await setup();try{await h.batch([1]);h.$('#batchCat').click();assert.equal(h.$('[data-bcat="12"]'),null);h.w.UI.closeSheet();h.$('#batchExit').click();await h.batch([1,2]);assert.equal(h.$('#batchCat').disabled,true)}finally{h.close()}
});
test('batch write revalidates account currency immediately before saving',async()=>{
 const h=await setup();try{await h.batch([1]);h.$('#batchAcc').click();h.accounts[1].currency='USD';h.$('[data-bacc="2"]').click();await turn();await turn();assert.equal(h.writes.length,0);assert.equal(h.rows[0].account_id,1)}finally{h.close()}
});
test('batch context clears selection on tab, book, identity or filter changes and removes stale pick boxes',async()=>{
 for(const change of ['tab','book','identity','filter']){
 const h=await setup();try{await h.batch([1]);if(change==='tab')h.state.tab='stats';if(change==='book')h.setBook(2);if(change==='identity')h.w.DB.state.sourceId='other';if(change==='filter')h.state.filters.keyword='other';
 h.w.UI.syncBatchContext(h.state);assert.equal(h.$('#batchBar').classList.contains('on'),false,change);assert.equal(h.$('.pick-box'),null,change);
 }finally{h.close()}}
});


test('valid batch edits keep amount and persist the chosen same-currency account',async()=>{
 const h=await setup();try{await h.batch([1]);h.$('#batchAcc').click();h.$('[data-bacc="2"]').click();await turn();await turn();assert.equal(h.writes.length,1);assert.equal(h.rows[0].account_id,2);assert.equal(h.rows[0].amount,100);assert.equal(h.$('#batchBar').classList.contains('on'),false)}finally{h.close()}
});
test('batch context change during an awaited read prevents subsequent writes',async()=>{
 const h=await setup();try{await h.batch([1]);let release;h.w.DB.getTransaction=()=>new Promise(r=>release=r);h.$('#batchAcc').click();h.$('[data-bacc="2"]').click();await turn();h.setBook(2);release(h.rows[0]);await turn();await turn();assert.equal(h.writes.length,0);assert.equal(h.$('#batchBar').classList.contains('on'),false)}finally{h.close()}
});
test('batch operations disable all actions while pending and retain only failed rows for retry',async()=>{
 const h=await setup();try{let release;h.w.DB.updateTransaction=()=>new Promise((r,j)=>release=()=>j(Error('模拟失败')));await h.batch([1]);h.$('#batchAcc').click();h.$('[data-bacc="2"]').click();await turn();assert.equal(h.$('#batchAcc').disabled,true);assert.equal(h.$('#batchExit').disabled,true);release();await turn();await turn();assert.equal(h.$('#batchBar').classList.contains('on'),true);assert.equal(h.$('#batchAcc').disabled,false);assert.equal(h.$('.txn[data-id="1"]').getAttribute('aria-pressed'),'true')}finally{h.close()}
});


test('confirmation prevents Ctrl or Cmd Enter from submitting the retained editor',async()=>{
 for(const modifier of ['ctrlKey','metaKey']){
 const h=await setup();try{await h.w.UI.openEditor(h.rows[0]);h.$('#noteInput').value='尚未保存';h.$('#edDelete').click();h.$('#cfNo').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',[modifier]:true,bubbles:true,cancelable:true}));await turn();assert.equal(h.writes.length,0);assert.ok(h.$('#confirmDialog'));assert.equal(h.$('#noteInput').value,'尚未保存')}finally{h.close()}}
});


test('unknown source accounts are blocked and missing currency consistently means CNY even with a USD base',async()=>{
 for(const missing of ['account','currency']){
 const h=await setup();try{h.w.Fmt.setBaseCurrency('USD');if(missing==='account')h.rows[0].account_id=null;else delete h.accounts[0].currency;await h.batch([1]);h.$('#batchAcc').click();assert.equal(h.$('[data-bacc="3"]').disabled,true,missing)}finally{h.close()}}
});


test('offline batch editing still reaches the existing sync queue with its reviewed version',async()=>{
 const h=await setup();try{
 h.w.DB.mode='cloud';h.w.DB.state.uid='cloud-user';h.rows[0].updated_at='2026-11-12T00:00:00Z';
 h.w.DB.getTransaction=async()=>{throw TypeError('Failed to fetch')};h.w.DB.updateTransaction=async()=>{throw TypeError('Failed to fetch')};
 h.w.eval(fs.readFileSync('js/sync.js','utf8'));h.w.Sync.install();
 await h.batch([1]);h.$('#batchAcc').click();h.$('[data-bacc="2"]').click();await turn();await turn();
 const queue=h.w.Sync.outbox();assert.equal(queue.length,1);assert.equal(queue[0].method,'updateTransaction');assert.equal(queue[0].args[0],1);assert.equal(queue[0].args[1].account_id,2);assert.equal(queue[0].args[2],h.rows[0].updated_at);
 }finally{h.close()}
});
