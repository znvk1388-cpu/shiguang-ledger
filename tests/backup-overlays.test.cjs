const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const { webcrypto } = require('node:crypto')
const meta = source => ({ version: 2, source, omitted: [] })
const owner = (mode, owner) => ({ mode, owner })
const key = (prefix, mode, id) => prefix + ':' + encodeURIComponent(JSON.stringify([mode, id]))
const data = () => ({ sourceId: 'src', accounts: [{ id: 2 }], categories: [{ id: 3 }], books: [{ id: 1 }], goals: [{ id: 5 }], transactions: [{ id: 4, txn_type: 'expense', amount: 5, occurred_at: '2026-10-28T12:00:00Z', account_id: 2, to_account_id: null, category_id: 3, note: '', updated_at: 'old' }] })
function setup(t, mode = 'cloud', id = 'B') {
  const dom = new JSDOM('<div id="sheet"></div><div id="mask"></div><div id="toast"></div>', { url: 'https://ledger.test', runScripts: 'outside-only', pretendToBeVisual: true })
  t.after(() => dom.window.close())
  const w = dom.window
  w.DB = { mode, state: { uid: id, sourceId: id, categories: [] } }
  w.App = { state: { attachments: {} }, refresh() {} }
  w.Lazy = { need: async () => null }; w.TXN_TYPE_LABEL = {}
  for (const f of ['format.js', 'ui.js']) w.eval(fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'))
  return w
}
test('export isolates namespace and nested owner data and reports ambiguous global values', t => {
  const w = setup(t, 'guest', 'src')
  w.localStorage.setItem(key('ledger10_reimb_v2', 'guest', 'src'), '{"4":{"status":"received"}}')
  w.localStorage.setItem(key('ledger10_reimb_v2', 'cloud', 'other'), '{"4":{"status":"partial"}}')
  w.localStorage.setItem('ledger10_reconcile_marks_v1', JSON.stringify({ '["guest","src","2"]': { 4: 'sig' }, '["cloud","other","2"]': { 4: 'secret' } }))
  w.localStorage.setItem('ledger10_goallink', '{"5":{"accountId":2,"auto":true}}')
  w.localStorage.setItem('ledger10_lock', '{"pin":"secret"}')
  w.localStorage.setItem('ledger10_sync2:out:guest', '[]')
  const out = w.UI.collectOverlays(data())
  assert.equal(out[key('ledger10_reimb_v2', 'cloud', 'other')], undefined)
  assert.deepEqual(JSON.parse(out.ledger10_reconcile_marks_v1), { '["guest","src","2"]': { 4: 'sig' } })
  assert.equal(out.ledger10_goallink, undefined)
  assert.equal(out.__ledger10_overlay.source.owner, 'src')
  assert.ok(out.__ledger10_overlay.omitted.some(x => x.name.includes('目标') && x.count === 1))
  assert.equal(out.ledger10_lock, undefined); assert.equal(out['ledger10_sync2:out:guest'], undefined)
})
test('cloud merge remaps reimbursement and saved filters to target while retaining existing target records', t => {
  const w = setup(t)
  const target = key('ledger10_reimb_v2', 'cloud', 'B')
  w.localStorage.setItem(target, '{"90":{"status":"partial"}}')
  const overlays = {
    __ledger10_overlay: meta(owner('guest', 'src')),
    [key('ledger10_reimb_v2', 'guest', 'src')]: '{"4":{"status":"received"},"404":{"status":"received"}}',
    [key('ledger10_saved_filters_v1', 'guest', 'src')]: '[{"name":"午饭","filters":{"accountId":2,"categoryId":3}}]',
  }
  const context = { maps: { txnMap: { 4: 40 }, accMap: { 2: 20 }, catMap: { 3: 30 } }, data: data(), report: {} }
  assert.equal(w.UI.applyOverlays(overlays, context), 2)
  assert.deepEqual(JSON.parse(w.localStorage.getItem(target)), { 40: { status: 'received' }, 90: { status: 'partial' } })
  assert.equal(w.localStorage.getItem(key('ledger10_reimb_v2', 'guest', 'src')), null)
  assert.equal(JSON.parse(w.localStorage.getItem(key('ledger10_saved_filters_v1', 'cloud', 'B')))[0].filters.accountId, 20)
  assert.ok(context.report.skipped >= 1)
})
test('known-source schemas remap goals/accounts/categories and rule actions without changing name match conditions', t => {
  const w = setup(t)
  const overlays = { __ledger10_overlay: meta(owner('cloud', 'A')),
    ledger10_goallink: '{"5":{"accountId":2,"auto":true}}', ledger10_goalauto: '{"5":{"amount":10,"last":"2026-10-01"}}',
    ledger10_card_meta: '{"2":{"limit":500,"billDay":2,"dueDay":20}}', ledger10_debt_meta: '{"2":{"due":"2026-12-01","note":"借款"}}', ledger10_debt_rate: '{"2":{"apr":0.12,"min":10}}',
    ledger10_rollover: '{"3":1}', ledger10_lastpick: '{"acc":{"expense":2},"cat":{"expense":3}}',
    ledger10_recon_log: '[{"accountId":2,"at":"2026-10-01","from":10,"to":20}]',
    ledger10_rules: '[{"id":"r1","name":"午饭","field":"account","op":"equals","value":"现金","setCategoryId":3,"setAccountId":2}]',
    ledger10_import_accounts_v1: JSON.stringify({ '["cloud","A"]': { '银行卡': 2 }, '["cloud","other"]': { '隐私': 2 } }),
  }
  const maps = { accMap: { 2: 20 }, catMap: { 3: 30 }, goalMap: { 5: 50 }, bookMap: { 1: 10 } }
  assert.equal(w.UI.applyOverlays(overlays, { maps, data: data(), report: {} }), 10)
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ledger10_goallink')), { 50: { accountId: 20, auto: true } })
  assert.equal(JSON.parse(w.localStorage.getItem('ledger10_card_meta'))[20].dueDay, 20)
  assert.equal(JSON.parse(w.localStorage.getItem('ledger10_lastpick')).cat.expense, 30)
  const rule = JSON.parse(w.localStorage.getItem('ledger10_rules'))[0]
  assert.equal(rule.setAccountId, 20); assert.equal(rule.setCategoryId, 30); assert.equal(rule.value, '现金')
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ledger10_import_accounts_v1')), { '["cloud","B"]': { '银行卡': 20 } })
})
test('reconcile signatures are rebuilt from confirmed imported rows and stale source signatures are discarded', t => {
  const w = setup(t)
  const source = data(), row = source.transactions[0]
  const signature = r => JSON.stringify([r.txn_type, r.amount, r.occurred_at, r.account_id, r.to_account_id, r.category_id, r.note, r.updated_at])
  const target = { ...row, id: 40, account_id: 20, category_id: 30, updated_at: 'new', tags: ['_op:mig-src:4'] }
  const ov = { __ledger10_overlay: meta(owner('guest', 'src')), ledger10_reconcile_marks_v1: JSON.stringify({ '["guest","src","2"]': { 4: signature(row), 99: 'stale' } }) }
  const report = {}
  w.UI.applyOverlays(ov, { data: source, maps: { accMap: { 2: 20 }, catMap: { 3: 30 }, txnMap: { 4: 40 }, txnRows: { 4: target } }, report })
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ledger10_reconcile_marks_v1')), { '["cloud","B","20"]': { 40: signature(target) } })
  assert.ok(report.skipped >= 1)
})
test('legacy ambiguous association values stay untouched and malformed metadata cannot claim ownership', t => {
  const w = setup(t)
  w.localStorage.setItem('ledger10_goallink', '{"7":{"accountId":8}}')
  const report = {}
  assert.equal(w.UI.applyOverlays({ ledger10_goallink: '{"5":{"accountId":2}}', ledger10_reimb: '{"4":{"status":"received"}}', ledger10_fx: '{"USD":7}' }, { report }), 1)
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ledger10_goallink')), { 7: { accountId: 8 } })
  assert.ok(report.skipped >= 2)
})
test('guest replacement restores same IDs in the restored source namespace and prevents source-owner pollution', t => {
  const w = setup(t, 'guest', 'src')
  const ov = { __ledger10_overlay: meta(owner('guest', 'src')), [key('ledger10_reimb_v2', 'guest', 'src')]: '{"4":{"status":"received"}}', [key('ledger10_reimb_v2', 'cloud', 'intruder')]: '{"4":{"status":"partial"}}' }
  w.UI.applyOverlays(ov, { replace: true, data: data(), report: {} })
  assert.equal(JSON.parse(w.localStorage.getItem(key('ledger10_reimb_v2', 'guest', 'src')))[4].status, 'received')
  assert.equal(w.localStorage.getItem(key('ledger10_reimb_v2', 'cloud', 'intruder')), null)
})

function cryptoSetup(w) {
  Object.defineProperty(w, 'crypto', { value: webcrypto })
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob
  w.eval(fs.readFileSync(path.join(__dirname, '../js/vault.js'), 'utf8'))
}
test('encrypted guest export carries only current-owner overlays and reports unsupported global settings', async t => {
  const w = setup(t, 'guest', 'src'); cryptoSetup(w)
  w.GuestStore = { state: w.DB.state, backup: async () => ({ app: 'ledger10', version: 2, data: data() }) }
  w.localStorage.setItem(key('ledger10_reimb_v2', 'guest', 'src'), '{"4":{"status":"received"}}')
  w.localStorage.setItem(key('ledger10_reimb_v2', 'cloud', 'other'), '{"4":{"status":"partial"}}')
  w.localStorage.setItem('ledger10_card_meta', '{"2":{"limit":100}}')
  let downloaded
  w.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test' }
  w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () {}
  const result = await w.Vault.exportLocal('password123')
  assert.equal(result.ok, true)
  const box = await w.Vault.decryptSnapshot(await downloaded.text(), 'password123')
  assert.ok(box.snap.backup.overlays[key('ledger10_reimb_v2', 'guest', 'src')])
  assert.equal(box.snap.backup.overlays[key('ledger10_reimb_v2', 'cloud', 'other')], undefined)
  assert.match(result.overlayWarning, /信用卡设置 1/)
})
test('encrypted full backup imports into cloud with returned mappings and retains existing target state', async t => {
  const w = setup(t); cryptoSetup(w)
  const backup = { app: 'ledger10', version: 2, data: data(), overlays: { __ledger10_overlay: meta(owner('guest', 'src')), [key('ledger10_reimb_v2', 'guest', 'src')]: '{"4":{"status":"received"}}' } }
  const text = await w.Vault.encryptSnapshot({ kind: 'guest-full-v1', backup }, 'password123', '')
  w.confirmSheet = async () => true
  w.DB.importDumpToCloud = async () => ({ txns: 1, txnMap: { 4: 40 }, accMap: { 2: 20 }, catMap: { 3: 30 }, txnFail: [], imgFail: [], ruleFail: [], tplFail: [] })
  const target = key('ledger10_reimb_v2', 'cloud', 'B')
  w.localStorage.setItem(target, '{"90":{"status":"partial"}}')
  const result = await w.Vault.restoreLocal({ text: async () => text }, 'password123')
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(w.localStorage.getItem(target)), { 40: { status: 'received' }, 90: { status: 'partial' } })
})
test('encrypted guest replacement applies overlays after restore changes the guest source identity', async t => {
  const w = setup(t, 'guest', 'old'); cryptoSetup(w)
  const backup = { app: 'ledger10', version: 2, data: data(), overlays: { __ledger10_overlay: meta(owner('guest', 'src')), [key('ledger10_reimb_v2', 'guest', 'src')]: '{"4":{"status":"received"}}' } }
  const text = await w.Vault.encryptSnapshot({ kind: 'guest-full-v1', backup }, 'password123', '')
  w.confirmSheet = async () => true
  w.GuestStore = { state: w.DB.state, restore: async () => { w.DB.state.sourceId = 'src'; return { txns: 1 } } }
  const result = await w.Vault.restoreLocal({ text: async () => text }, 'password123')
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(w.localStorage.getItem(key('ledger10_reimb_v2', 'guest', 'src')))[4].status, 'received')
})

test('JSON cloud restore passes confirmed ID maps into overlays', async t => {
  const w = setup(t)
  const payload = { app: 'ledger10', version: 2, data: data(), overlays: { __ledger10_overlay: meta(owner('guest', 'src')), [key('ledger10_reimb_v2', 'guest', 'src')]: '{"4":{"status":"received"}}' } }
  w.DB.importDumpToCloud = async () => ({ txns: 1, txnMap: { 4: 40 }, accMap: { 2: 20 }, catMap: { 3: 30 } })
  w.UI.openBackupSheet()
  const file = w.document.querySelector('#bakFile')
  Object.defineProperty(file, 'files', { value: [{ text: async () => JSON.stringify(payload) }] })
  file.dispatchEvent(new w.Event('change'))
  await new Promise(resolve => setImmediate(resolve))
  w.document.querySelector('#cfYes').click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(w.localStorage.getItem(key('ledger10_reimb_v2', 'cloud', 'B'))), { 40: { status: 'received' } })
})
test('encrypted cloud export uses raw IDs and stable source identity instead of a name-based sharing snapshot', async t => {
  const w = setup(t, 'cloud', 'A'); cryptoSetup(w)
  const source = data()
  Object.assign(w.DB, { allAccounts: () => source.accounts, books: () => source.books,
    listTransactions: async () => ({ rows: source.transactions }), listRecurring: async () => [], listTemplates: async () => [] })
  Object.assign(w.DB.state, { categories: source.categories, goals: source.goals })
  w.localStorage.setItem(key('ledger10_reimb_v2', 'cloud', 'A'), '{"4":{"status":"received"}}')
  let downloaded
  w.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test' }; w.URL.revokeObjectURL = () => {}
  w.HTMLAnchorElement.prototype.click = function () {}
  const result = await w.Vault.exportLocal('password123')
  assert.equal(result.ok, true)
  const box = await w.Vault.decryptSnapshot(await downloaded.text(), 'password123')
  assert.equal(box.snap.backup.data.sourceId, 'cloud:A')
  assert.equal(box.snap.backup.data.transactions[0].txn_type, 'expense')
  assert.ok(box.snap.backup.overlays[key('ledger10_reimb_v2', 'cloud', 'A')])
})

test('stale mappings cannot restore an entity absent from this source backup', t => {
  const w = setup(t), report = {}
  const ov = { __ledger10_overlay: meta(owner('cloud', 'A')), ledger10_goallink: '{"999":{"accountId":2}}' }
  assert.equal(w.UI.applyOverlays(ov, { data: data(), maps: { goalMap: { 999: 99 }, accMap: { 2: 20 } }, report }), 0)
  assert.equal(w.localStorage.getItem('ledger10_goallink'), null)
  assert.equal(report.skipped, 1)
})
test('reconcile skips a target row whose imported payload no longer matches the reviewed source', t => {
  const w = setup(t), source = data(), row = source.transactions[0], report = {}
  const sig = JSON.stringify([row.txn_type, row.amount, row.occurred_at, row.account_id, row.to_account_id, row.category_id, row.note, row.updated_at])
  const ov = { __ledger10_overlay: meta(owner('guest', 'src')), ledger10_reconcile_marks_v1: JSON.stringify({ '["guest","src","2"]': { 4: sig } }) }
  assert.equal(w.UI.applyOverlays(ov, { data: source, maps: { txnMap: { 4: 40 }, accMap: { 2: 20 }, catMap: { 3: 30 }, txnRows: { 4: { ...row, id: 40, amount: 999, account_id: 20, category_id: 30 } } }, report }), 0)
  assert.equal(report.skipped, 1)
})
test('malformed source metadata never grants unscoped association ownership', t => {
  const w = setup(t), report = {}
  assert.equal(w.UI.applyOverlays({ __ledger10_overlay: { version: 2, source: { mode: 'cloud', owner: 1 } }, ledger10_goallink: '{"5":{"accountId":2}}' }, { maps: { goalMap: { 5: 50 }, accMap: { 2: 20 } }, report }), 0)
  assert.equal(report.skipped, 1)
})

test('JSON guest restore cannot apply late overlays or reenter guest after switching to cloud', async t => {
  const w=setup(t,'guest','old'),payload={app:'ledger10',version:2,data:data(),overlays:{__ledger10_overlay:meta(owner('guest','src')),[key('ledger10_reimb_v2','guest','src')]:'{"4":{"status":"done"}}'}};
  let entered=0;w.DB.useGuest=async()=>{entered++;w.DB.mode='guest'};
  w.GuestStore={state:{sourceId:'src'},restore:async()=>{w.DB.mode='cloud';w.DB.state={uid:'B'};return{txns:1}}};
  w.UI.openBackupSheet();const input=w.document.querySelector('#bakFile');Object.defineProperty(input,'files',{value:[{text:async()=>JSON.stringify(payload)}]});input.dispatchEvent(new w.Event('change'));await new Promise(r=>setImmediate(r));w.document.querySelector('#cfYes').click();await new Promise(r=>setImmediate(r));
  assert.equal(entered,0);assert.equal(w.localStorage.getItem(key('ledger10_reimb_v2','guest','src')),null);assert.match(w.document.querySelector('#bakErr').textContent,/切换/);
});
test('encrypted guest restore cannot apply late overlays after switching to cloud', async t => {
  const w=setup(t,'guest','old');cryptoSetup(w);const full={app:'ledger10',version:2,data:data(),overlays:{__ledger10_overlay:meta(owner('guest','src')),[key('ledger10_reimb_v2','guest','src')]:'{"4":{"status":"done"}}'}};
  const text=await w.Vault.encryptSnapshot({kind:'guest-full-v1',backup:full},'password123','');w.confirmSheet=async()=>true;w.GuestStore={state:{sourceId:'src'},restore:async()=>{w.DB.mode='cloud';w.DB.state={uid:'B'};return{txns:1}}};
  const result=await w.Vault.restoreLocal({text:async()=>text},'password123');assert.match(result.error,/切换/);assert.equal(w.localStorage.getItem(key('ledger10_reimb_v2','guest','src')),null);
});
test('full cloud backup replacing guest retains raw IDs while changing namespace to the restored guest source',t=>{
 const w=setup(t,'guest','cloud:A'),source=data();source.sourceId='cloud:A';const report={};
 const ov={__ledger10_overlay:meta(owner('cloud','A')),[key('ledger10_reimb_v2','cloud','A')]:'{"4":{"status":"done"}}'};
 assert.equal(w.UI.applyOverlays(ov,{replace:true,data:source,target:owner('guest','cloud:A'),report}),1);
 assert.equal(JSON.parse(w.localStorage.getItem(key('ledger10_reimb_v2','guest','cloud:A')))[4].status,'done');assert.equal(report.skipped,0);
});


test('partial JSON imports retain a visible warning instead of reporting complete restoration',async t=>{
 const w=setup(t),payload={app:'ledger10',version:2,data:data(),overlays:{__ledger10_overlay:meta(owner('guest','src'))}};
 w.DB.importDumpToCloud=async()=>({txns:0,txnMap:{},txnFail:[{id:4,msg:'原账目已更新'}]});w.UI.openBackupSheet();
 const f=w.document.querySelector('#bakFile');Object.defineProperty(f,'files',{value:[{text:async()=>JSON.stringify(payload)}]});f.dispatchEvent(new w.Event('change'));await new Promise(r=>setImmediate(r));w.document.querySelector('#cfYes').click();await new Promise(r=>setImmediate(r));
 assert.match(w.document.querySelector('#bakErr').textContent,/1.*未恢复/);assert.match(w.document.querySelector('#bakErr').textContent,/原账目已更新/);assert.equal(w.document.querySelector('#sheet').getAttribute('aria-hidden'),'false');
});
test('encrypted partial imports explain current-record conflicts rather than promising automatic retry success',async t=>{
 const w=setup(t);cryptoSetup(w);w.confirmSheet=async()=>true;w.DB.importDumpToCloud=async()=>({txns:0,txnMap:{},txnFail:[{id:4,msg:'原账目已更新'}]});
 const full={app:'ledger10',version:2,data:data(),overlays:{__ledger10_overlay:meta(owner('guest','src'))}},text=await w.Vault.encryptSnapshot({kind:'ledger-full-v2',backup:full},'password123','');
 const r=await w.Vault.restoreLocal({text:async()=>text},'password123');assert.equal(r.stats.failed,1);assert.match(r.overlayWarning,/原账目已更新/);
});
