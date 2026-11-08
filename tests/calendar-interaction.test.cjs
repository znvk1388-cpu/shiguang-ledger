const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { JSDOM } = require('jsdom')

function setup() {
  const dom = new JSDOM('<main id="mainView"><div id="content"></div></main>', { url:'https://ledger.test', runScripts:'outside-only' })
  const w=dom.window
  w.localStorage.setItem('ledger10_home_budget','off')
  w.DB={mode:'guest',activeBookId:()=>1,listRecurring:async()=>[],listAttachments:async()=>({}),
    listTransactions:async()=>({rows:[{id:1,txn_type:'expense',amount:15,account_id:1,category_id:1,occurred_at:'2026-11-06T12:00:00+08:00'}],total:1}),
    category:()=>({id:1,name:'餐饮',icon:'餐',color:'#6688aa'}),categoryName:()=> '餐饮',accountName:()=> '现金'}
  const state={tab:'home',homeView:'cal',scope:'month',year:2026,month:11,calDay:'2026-11-06',filters:{},loaded:100}
  w.eval(fs.readFileSync('js/format.js','utf8'));w.eval(fs.readFileSync('js/ui.js','utf8'))
  w.App={state,bindContentEvents(){},refresh:()=>w.UI.renderHome(state)}
  return {w,state,close:()=>w.close(),$:s=>w.document.querySelector(s),$$:s=>[...w.document.querySelectorAll(s)]}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve))

test('calendar dates are native named toggle buttons with one tab stop and private labels',async()=>{
  const h=setup()
  try {
    await h.w.UI.renderHome(h.state)
    const day=h.$('[data-day="2026-11-06"]')
    assert.equal(day.tagName,'BUTTON')
    assert.equal(day.getAttribute('aria-pressed'),'true')
    assert.match(day.getAttribute('aria-label'),/2026年11月6日.*星期五.*支出.*15\.00/)
    assert.equal(h.$$('.cal-cell[tabindex="0"]').length,1)
    assert.equal(day.tabIndex,0)
    assert.ok(h.$$('.cal-cell.other').every(el=>el.tagName!=='BUTTON'&&el.tabIndex<0))
    h.w.localStorage.setItem('ledger10_privacy','1');await h.w.UI.renderHome(h.state)
    assert.doesNotMatch(h.$('[data-day="2026-11-06"]').getAttribute('aria-label'),/15\.00/)
    assert.match(h.$('[data-day="2026-11-06"]').getAttribute('aria-label'),/金额已隐藏/)
  }finally{h.close()}
})

test('calendar arrow navigation moves focus without selecting and activation keeps focus after redraw',async()=>{
  const h=setup()
  try {
    await h.w.UI.renderHome(h.state)
    const day=h.$('[data-day="2026-11-06"]');day.focus()
    function key(value){h.w.document.activeElement.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}))}
    key('ArrowDown');assert.equal(h.w.document.activeElement.dataset.day,'2026-11-13')
    assert.equal(h.state.calDay,'2026-11-06')
    key('Home');assert.equal(h.w.document.activeElement.dataset.day,'2026-11-09')
    key('End');assert.equal(h.w.document.activeElement.dataset.day,'2026-11-15')
    key('ArrowLeft');assert.equal(h.w.document.activeElement.dataset.day,'2026-11-14')
    h.w.document.activeElement.click();await turn();await turn()
    assert.equal(h.state.calDay,'2026-11-14')
    assert.equal(h.w.document.activeElement.dataset.day,'2026-11-14')
    assert.equal(h.w.document.activeElement.getAttribute('aria-pressed'),'true')
    h.w.document.activeElement.click();await turn();await turn()
    assert.equal(h.state.calDay,null)
    assert.equal(h.w.document.activeElement.dataset.day,'2026-11-14')
    assert.equal(h.w.document.activeElement.getAttribute('aria-pressed'),'false')
    assert.equal(h.$$('.cal-cell[tabindex="0"]').length,1)
  }finally{h.close()}
})

test('calendar response preserves the date focused after activation during a slow request',async()=>{
  const h=setup()
  try {
    await h.w.UI.renderHome(h.state)
    const data=await h.w.DB.listTransactions()
    let finish
    h.w.DB.listTransactions=()=>new Promise(resolve=>{finish=resolve})
    const selected=h.$('[data-day="2026-11-14"]')
    selected.focus();selected.click()
    await turn()
    assert.equal(typeof finish,'function','date activation reached the delayed request')
    selected.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))
    assert.equal(h.w.document.activeElement.dataset.day,'2026-11-15')
    finish(data);await turn();await turn()
    assert.equal(h.state.calDay,'2026-11-14','moving focus does not change selection')
    assert.equal(h.w.document.activeElement,h.$('[data-day="2026-11-15"]'))
    assert.equal(h.$('[data-day="2026-11-14"]').getAttribute('aria-pressed'),'true')
    assert.equal(h.$('[data-day="2026-11-15"]').getAttribute('aria-pressed'),'false')
    assert.equal(h.$$('.cal-cell[tabindex="0"]').length,1)
    assert.equal(h.$('[data-day="2026-11-15"]').tabIndex,0)
  }finally{h.close()}
})

test('calendar response never takes focus back from a control outside the calendar',async()=>{
  const h=setup()
  try {
    await h.w.UI.renderHome(h.state)
    const data=await h.w.DB.listTransactions()
    let finish
    h.w.DB.listTransactions=()=>new Promise(resolve=>{finish=resolve})
    const selected=h.$('[data-day="2026-11-14"]')
    selected.focus();selected.click()
    await turn()
    assert.equal(typeof finish,'function','date activation reached the delayed request')
    const outside=h.w.document.createElement('button')
    outside.textContent='日历外的操作'
    h.$('#mainView').appendChild(outside)
    outside.focus()
    finish(data);await turn();await turn()
    assert.equal(h.state.calDay,'2026-11-14')
    assert.equal(h.w.document.activeElement,outside)
    assert.equal(h.$$('.cal-cell[tabindex="0"]').length,1)
  }finally{h.close()}
})
