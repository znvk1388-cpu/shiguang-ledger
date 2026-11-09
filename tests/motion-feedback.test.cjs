const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')
const turn = () => new Promise(resolve => setImmediate(resolve))
function setup({ reduced = false, write, upload } = {}) {
  const dom = new JSDOM('<main id="mainView"><button id="opener">记一笔</button><div id="content">当前记录</div></main><div id="sheet" tabindex="-1"></div><div id="mask"></div><div id="toast"></div>', { url:'https://ledger.test', runScripts:'outside-only', pretendToBeVisual:true })
  const w=dom.window, animations=[]
  let listener, writes=0
  const media={matches:reduced,addEventListener:(name,fn)=>{listener=fn}}
  w.matchMedia=()=>media
  w.HTMLElement.prototype.animate=function(frames,options){
    let resolve,reject
    const finished=new Promise((yes,no)=>{resolve=yes;reject=no})
    const a={target:this,frames,options,finished,cancels:0,cancel(){this.cancels++;reject(Error('cancelled'))},finish(){resolve()}}
    animations.push(a);return a
  }
  const account={id:1,name:'现金',currency:'CNY'}, category={id:1,name:'餐饮',txn_type:'expense'}
  w.eval(fs.readFileSync('js/format.js','utf8'))
  w.TXN_TYPE_LABEL={expense:'支出',income:'收入',transfer:'转账'}
  w.Lazy={need:async()=>null}
  w.DB={mode:'guest',state:{sourceId:'isolated',categories:[category]},accounts:()=>[account],allAccounts:()=>[account],
    category:()=>category,rootCategories:()=>[category],childCategories:()=>[],categoryName:()=>category.name,accountName:()=>account.name,budgetOf:()=>null,
    addTransaction:async payload=>{writes++;return write?write(payload):{id:1}},uploadImage:upload|| (async()=>({id:2})),addAttachments:async()=>{}}
  w.App={state:{attachments:{}},refresh:async()=>{}}
  w.URL.createObjectURL=()=> 'blob:isolated-receipt';w.URL.revokeObjectURL=()=>{}
  w.confirm=()=>true
  w.eval(fs.readFileSync('js/ui.js','utf8'))
  return {w,dom,animations,media,$:s=>w.document.querySelector(s),writes:()=>writes,
    preference(value){media.matches=value;listener?.({matches:value})},close:()=>w.close()}
}

test('new feedback replaces only the previous animation and finished effects release ownership',async()=>{
  const h=setup()
  try {
    const el=h.$('#content')
    h.w.UI.animateFeedback(el,'page');const first=h.animations[0]
    h.w.UI.animateFeedback(el,'page');const second=h.animations[1]
    assert.equal(first.cancels,1);assert.equal(second.cancels,0)
    await turn()
    h.w.UI.animateFeedback(el,'page');const third=h.animations[2]
    assert.equal(second.cancels,1,'old completion must not forget the current animation')
    third.finish();await turn();h.preference(true)
    assert.equal(third.cancels,0,'finished effects should not remain registered')
    assert.equal(el.textContent,'当前记录');assert.equal(el.style.opacity,'')
  }finally{h.close()}
})

test('reduced motion and unavailable animation APIs leave content usable immediately',()=>{
  const h=setup({reduced:true})
  try {
    const el=h.$('#content');h.w.UI.animateFeedback(el,'page');assert.equal(h.animations.length,0)
    h.preference(false);el.animate=undefined
    assert.doesNotThrow(()=>h.w.UI.animateFeedback(el,'page'))
    h.w.UI.animateFeedback(h.w.document.createElement('div'),'page')
    assert.equal(h.animations.length,0);assert.equal(el.textContent,'当前记录');assert.equal(el.getAttribute('style'),null)
  }finally{h.close()}
})

test('turning on reduced motion cancels running feedback and suppresses future effects',async()=>{
  const h=setup()
  try {
    h.w.UI.animateFeedback(h.$('#content'),'page');h.w.UI.animateFeedback(h.$('#opener'),'page')
    h.preference(true);assert.ok(h.animations.every(a=>a.cancels===1))
    h.w.UI.animateFeedback(h.$('#content'),'page');assert.equal(h.animations.length,2)
    await turn();h.preference(false);h.w.UI.animateFeedback(h.$('#content'),'page');assert.equal(h.animations.length,3)
  }finally{h.close()}
})

test('replacing then closing a sheet cancels its feedback and restores accessible focus immediately',async()=>{
  const h=setup()
  try {
    h.$('#opener').focus();h.w.UI.openSheet('<b class="sheet-title">旧面板</b>')
    await new Promise(resolve=>h.w.requestAnimationFrame(resolve))
    h.w.UI.openSheet('<b class="sheet-title">新面板</b>')
    await new Promise(resolve=>h.w.requestAnimationFrame(resolve))
    assert.equal(h.$('#sheet').textContent,'新面板');assert.equal(h.animations.length,1)
    const a=h.animations[0];h.w.UI.closeSheet()
    assert.equal(a.cancels,1);assert.equal(h.$('#sheet').getAttribute('aria-hidden'),'true')
    assert.equal(h.$('#sheet').hasAttribute('inert'),true);assert.equal(h.w.document.activeElement.id,'opener')
    h.w.UI.openSheet('<b class="sheet-title">即时打开</b>');h.w.UI.closeSheet()
    await new Promise(resolve=>h.w.requestAnimationFrame(resolve))
    assert.equal(h.$('#sheet').classList.contains('on'),false)
  }finally{h.close()}
})

test('save feedback reflects a pending write, blocks a second submission, then confirms a successful commit',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve}),h=setup({write:()=>gate})
  try {
    await h.w.UI.openEditor(null);h.$('#amtInput').value='12.50';const save=h.$('#edSave');save.click();save.click()
    assert.equal(h.writes(),1);assert.equal(save.disabled,true);assert.equal(save.getAttribute('aria-busy'),'true')
    assert.equal(save.classList.contains('is-loading'),true);assert.match(save.textContent,/保存中/)
    release({id:1});await turn();await turn()
    assert.equal(save.classList.contains('is-loading'),false);assert.equal(save.hasAttribute('aria-busy'),false)
    assert.equal(h.$('#sheet').getAttribute('aria-hidden'),'true');assert.match(h.$('#toast').textContent,/已记录/)
    assert.ok(h.$('#toast use[href$="#check"]'))
  }finally{h.close()}
})

test('a failed save removes busy feedback and leaves the draft available for retry',async()=>{
  const h=setup({write:async()=>{throw Error('offline')}})
  try {
    await h.w.UI.openEditor(null);h.$('#amtInput').value='12.50';h.$('#edSave').click();await turn()
    const save=h.$('#edSave');assert.equal(save.disabled,false);assert.equal(save.hasAttribute('aria-busy'),false)
    assert.equal(save.classList.contains('is-loading'),false);assert.equal(h.$('#amtInput').value,'12.50')
    assert.match(h.$('#edErr').textContent,/保存失败/);assert.equal(h.$('#toast use[href$="#check"]'),null)
  }finally{h.close()}
})

test('partial attachment completion does not show the successful-save check',async()=>{
  const h=setup({upload:async()=>{throw Error('upload failed')}})
  try {
    await h.w.UI.openEditor(null);h.$('#amtInput').value='12.50'
    const input=h.$('#fileInput');Object.defineProperty(input,'files',{value:[new h.w.File(['x'],'receipt.png',{type:'image/png'})]})
    input.dispatchEvent(new h.w.Event('change',{bubbles:true}));h.$('#edSave').click();await turn();await turn()
    assert.equal(h.writes(),1);assert.match(h.$('#toast').textContent,/凭证上传失败/)
    assert.equal(h.$('#toast use[href$="#check"]'),null)
  }finally{h.close()}
})
