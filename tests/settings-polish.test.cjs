const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');const{JSDOM}=require('jsdom');
const turn=()=>new Promise(r=>setImmediate(r));
function setup(){
 const dom=new JSDOM('<main id="mainView"><div id="content"></div></main><div id="sheet"></div><div id="mask"></div><div id="toast"></div>',{url:'https://ledger.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.eval(fs.readFileSync('js/format.js','utf8'));w.TXN_TYPE_LABEL={};w.Lazy={need:async()=>null};w.DB={mode:'guest',state:{sourceId:'me-test',categories:[]},activeBookId:()=>1,storageUsage:async()=>({count:0,bytes:0}),listTransactions:async()=>({rows:[],total:0}),budgetOf:()=>null,setBudget:async()=>{}};
 const state={tab:'me',scope:'month',year:2026,month:11,homeView:'list',filters:{}};w.App={state,version:'test',themeMode:()=> 'light',lockConfig:()=>({on:false}),uiSettings:()=>({scale:'normal',palette:'bright'}),refresh:async()=>{}};w.eval(fs.readFileSync('js/ui.js','utf8'));
 return{w,state,$:s=>w.document.querySelector(s),close:()=>w.close(),fold:()=>Array.from(w.document.querySelectorAll('.me-fold')).find(e=>e.querySelector('summary').textContent==='外观与提醒')};
}
test('settings rows are native named buttons and budget expansion exposes its state and input label',async()=>{
 const h=setup();try{await h.w.UI.renderMe(h.state);const action=h.$('#catManage');assert.equal(action.tagName,'BUTTON');action.focus();assert.equal(h.w.document.activeElement,action);assert.match(action.textContent,/分类管理/);const budget=h.$('#budgetRow');assert.equal(budget.tagName,'BUTTON');assert.equal(budget.getAttribute('aria-expanded'),'false');budget.click();assert.equal(budget.getAttribute('aria-expanded'),'true');assert.equal(h.$('#budgetEdit').classList.contains('hidden'),false);assert.ok(h.$('#budgetInput').getAttribute('aria-label'))}finally{h.close()}
});
test('settings fold choices survive refresh including a toggle made during an awaited read',async()=>{
 const h=setup();try{await h.w.UI.renderMe(h.state);h.fold().open=true;await h.w.UI.renderMe(h.state);assert.equal(h.fold().open,true);let release;h.w.DB.storageUsage=()=>new Promise(r=>release=r);const p=h.w.UI.renderMe(h.state);h.fold().open=false;release({count:0,bytes:0});await p;assert.equal(h.fold().open,false);await turn();h.w.DB.storageUsage=async()=>({count:0,bytes:0});await h.w.UI.renderMe(h.state);assert.equal(h.fold().open,false)}finally{h.close()}
});
test('late settings response never replaces a different tab or identity',async()=>{
 for(const change of ['tab','identity']){
 const h=setup();try{let release;h.w.DB.storageUsage=()=>new Promise(r=>release=r);const p=h.w.UI.renderMe(h.state);if(change==='tab')h.state.tab='stats';else h.w.DB.state.sourceId='other-source';h.$('#content').innerHTML='<button id="currentMarker">当前页面</button>';release({count:0,bytes:0});await p;assert.ok(h.$('#currentMarker'),change)}finally{h.close()}}
});
