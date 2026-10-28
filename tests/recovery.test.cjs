const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const { JSDOM } = require('jsdom');

const source = name => fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8');
function memoryStorage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}
async function guest(indexedDB = new IDBFactory(), initialize = true) {
  const window = { crypto: webcrypto };
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => { this.result = 'data:' + (blob.type || '') + ';base64,' + Buffer.from(bytes).toString('base64'); this.onload(); }, error => { this.error = error; this.onerror(); });
    }
  }
  const context = vm.createContext({ window, indexedDB, localStorage: memoryStorage(), URL, fetch, Blob, FileReader, TextEncoder, TextDecoder, console });
  for (const name of ['format.js', 'idb.js', 'guest-store.js']) vm.runInContext(source(name), context, { filename: name });
  if (initialize) await window.GuestStore.init();
  return window;
}
test('guest backup fails instead of silently omitting an unreadable attachment', async () => {
  const w = await guest();
  const all = w.Idb.all;
  w.Idb.all = async name => name === 'attachments'
    ? [{ id: 1, blob: { type: 'image/png', arrayBuffer: async () => { throw new Error('read failed') } } }]
    : all(name);
  await assert.rejects(w.GuestStore.backup(), /附件.*读取|读取.*附件/);
});
function backup() {
  return {
    app: 'ledger10', version: 2, data: {
      sourceId: 'source-original-backup',
      accounts: [{ id: 11, name: '现金', currency: 'CNY', initial_balance: 0 }],
      categories: [{ id: 21, name: '餐饮', kind: 'expense' }],
      transactions: [{ id: 31, txn_type: 'expense', amount: 25, occurred_at: '2026-10-24T10:00:00Z', account_id: 11, category_id: 21 }],
    },
  };
}
const json = value => JSON.parse(JSON.stringify(value));

test('synchronous IndexedDB write failures abort queued clears in every store', async () => {
  const w = await guest();
  await w.Idb.put('accounts', { id: 1, name: 'original' });
  await w.Idb.put('transactions', { id: 1, note: 'keep me' });
  for (const bad of [{ id: {} }, { id: 2, callback() {} }]) {
    await assert.rejects(w.Idb.replaceAll({ accounts: [{ id: 9, name: 'replacement' }], transactions: [bad] }));
    assert.deepEqual(json(await w.Idb.all('accounts')), [{ id: 1, name: 'original' }]);
    assert.deepEqual(json(await w.Idb.all('transactions')), [{ id: 1, note: 'keep me' }]);
  }
});

test('restore rejects incomplete or corrupt tables before touching existing data or source identity', async () => {
  const w = await guest();
  await w.GuestStore.restore(backup());
  const before = json(await w.GuestStore.dump());
  const invalid = [
    { transactions: [] },
    { ...backup(), app: 'other-app' },
    { ...backup(), version: 99 },
    { ...backup().data, accounts: {} },
    { ...backup().data, goals: [null] },
    { ...backup().data, transactions: [{ ...backup().data.transactions[0], id: {} }] },
    { ...backup().data, accounts: [backup().data.accounts[0], backup().data.accounts[0]] },
    { ...backup().data, transactions: [{ ...backup().data.transactions[0], amount: 'NaN' }] },
    { ...backup().data, transactions: [{ ...backup().data.transactions[0], occurred_at: 'invalid' }] },
    { ...backup().data, transactions: [{ ...backup().data.transactions[0], unsupported() {} }] },
    { ...backup().data, attachments: [{ id: 1, dataUrl: 'https://example.com/file' }] },
    { ...backup().data, attachments: [{ id: 1, dataUrl: 'data:text/plain;base64,%%%' }] },
  ];
  for (const data of invalid) {
    await assert.rejects(w.GuestStore.restore(data));
    assert.deepEqual(json(await w.GuestStore.dump()), before);
  }
});

test('legacy backups restore optional tables, attachments and stable source identity safely', async () => {
  const w = await guest();
  const originalSource = await w.GuestStore.sourceId();
  const legacy = backup();
  legacy.version = 1;
  delete legacy.data.sourceId;
  legacy.data.attachments = [{ id: 41, transaction_id: 31, file_name: 'receipt.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' }];
  await w.GuestStore.restore(legacy);
  const restoredSource = await w.GuestStore.sourceId();
  assert.notEqual(restoredSource, originalSource);
  assert.equal((await w.Idb.all('transactions')).length, 1);
  assert.equal((await w.Idb.all('templates')).length, 0);
  assert.equal((await w.Idb.all('books')).length, 1);
  assert.equal(await (await w.Idb.get('attachments', 41)).blob.text(), 'hello');
  assert.equal(legacy.data.attachments[0].dataUrl, 'data:text/plain;base64,aGVsbG8=');
  const exported = await w.GuestStore.backup();
  assert.equal(exported.data.sourceId, restoredSource);
  await w.GuestStore.init();
  assert.equal(w.GuestStore.state.sourceId, restoredSource);
  await w.GuestStore.restore(exported);
  assert.equal(await w.GuestStore.sourceId(), restoredSource);
  await w.GuestStore.wipe();
  await w.GuestStore.init();
  assert.notEqual(await w.GuestStore.sourceId(), restoredSource);
});

test('schema upgrade preserves version 3 data while adding persistent source identity', async () => {
  const factory = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = factory.open('ledger10-guest', 3);
    request.onupgradeneeded = () => {
      for (const name of ['accounts', 'categories', 'transactions', 'attachments', 'budgets', 'recurring', 'books', 'goals', 'templates']) request.result.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('accounts', 'readwrite');
      tx.objectStore('accounts').put({ id: 7, name: 'existing account' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  });
  const w = await guest(factory);
  assert.equal((await w.Idb.get('accounts', 7)).name, 'existing account');
  assert.ok(await w.GuestStore.sourceId());
});

test('legacy restore identities are stable across repeat exports and change with actual content, including fallback hashing', async () => {
  for (const cryptoAvailable of [true, false]) {
    const w = await guest();
    if (!cryptoAvailable) w.crypto = {};
    const legacy = backup();
    delete legacy.data.sourceId;
    legacy.exportedAt = '2026-10-24T00:00:00Z';
    await w.GuestStore.restore(legacy);
    const identity = await w.GuestStore.sourceId();
    assert.match(identity, /^legacy-/);
    const again = json(legacy);
    again.exportedAt = '2026-10-28T00:00:00Z';
    again.data.accounts[0] = { initial_balance: 0, currency: 'CNY', name: '现金', id: 11 };
    await w.GuestStore.restore(again);
    assert.equal(await w.GuestStore.sourceId(), identity);
    again.data.transactions[0].note = 'different content';
    await w.GuestStore.restore(again);
    assert.notEqual(await w.GuestStore.sourceId(), identity);
  }
});

test('blocked upgrade reports a retryable error and releases both late and version-changed connections', async () => {
  const factory = new IDBFactory();
  const previous = await new Promise((resolve, reject) => {
    const request = factory.open('ledger10-guest', 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const w = await guest(factory, false);
  await assert.rejects(w.GuestStore.init(), /其他标签页.*重试/);
  previous.close();
  await w.GuestStore.init();
  assert.ok(await w.GuestStore.sourceId());
  const upgraded = await new Promise((resolve, reject) => {
    const request = factory.open('ledger10-guest', 5);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('a rejected or version-changed connection was leaked'));
  });
  upgraded.close();
});

test('guest transfer writes and recurring edits reject cross currency without changing existing rows', async () => {
  const w = await guest();
  const a = await w.GuestStore.addAccount({ name: '人民币', currency: 'CNY' });
  const b = await w.GuestStore.addAccount({ name: '美元', currency: 'USD' });
  const c = await w.GuestStore.addAccount({ name: '现金' });
  const transfer = { txn_type: 'transfer', amount: 10, occurred_at: '2026-10-24T10:00:00Z', account_id: a.id, to_account_id: b.id };
  await assert.rejects(w.GuestStore.addTransaction({ ...transfer }), /跨币种/);
  await assert.rejects(w.GuestStore.addTransaction({ ...transfer, to_account_id: String(b.id) }), error => error.code === 'CROSS_CURRENCY_TRANSFER');
  await assert.rejects(w.GuestStore.addTransaction({ ...transfer, to_account_id: 9999 }), error => error.code === 'TRANSFER_ACCOUNT_REQUIRED');
  assert.equal((await w.Idb.all('transactions')).length, 0);
  const valid = await w.GuestStore.addTransaction({ ...transfer, to_account_id: c.id });
  await assert.rejects(w.GuestStore.updateTransaction(valid.id, { to_account_id: b.id }), /跨币种/);
  assert.equal((await w.Idb.get('transactions', valid.id)).to_account_id, c.id);
  const expense = await w.GuestStore.addTransaction({ txn_type: 'expense', amount: 10, account_id: a.id });
  await assert.rejects(w.GuestStore.updateTransaction(expense.id, { txn_type: 'transfer', to_account_id: b.id }), /跨币种/);
  assert.equal((await w.Idb.get('transactions', expense.id)).txn_type, 'expense');
  await assert.rejects(w.GuestStore.addRecurring({ ...transfer, start_date: '2026-10-24', freq: 'monthly' }), /跨币种/);
  const rule = await w.GuestStore.addRecurring({ ...transfer, to_account_id: c.id, start_date: '2026-10-24', freq: 'monthly' });
  await assert.rejects(w.GuestStore.updateRecurring(rule.id, { to_account_id: b.id }), /跨币种/);
  assert.equal((await w.Idb.get('recurring', rule.id)).to_account_id, c.id);
});

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('UI operation did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('encrypted restore retains selected file through redraw, wrong password and retry', async () => {
  const dom = new JSDOM('<div id="sheet"></div>', { url: 'https://example.test', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.ic = () => '';
  w.confirm = () => true;
  w.UI = { openSheet: html => { w.document.querySelector('#sheet').innerHTML = html; }, closeSheet: () => {}, toast: () => {} };
  let merged = 0;
  w.Lazy = { need: async () => ({ mergeSnapshot: async () => { merged++; return { transactions: 1, accounts: 1, failed: 0 }; } }) };
  w.App = { refresh: async () => {} };
  w.eval(source('format.js'));
  w.eval(source('vault.js'));
  const payload = await w.Vault.encryptSnapshot({ transactions: [{ amount: 25 }], accounts: [] }, 'password123', '');
  let reads = 0;
  const file = { name: 'backup.sgvault.json', size: payload.length, text: async () => { reads++; return payload; } };
  w.Vault.openLocalSheet();
  const input = w.document.querySelector('#vlFile');
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new w.Event('change'));
  assert.equal(w.document.querySelector('#vlFile').files.length, 0, 'redraw clears the native file input');
  assert.notEqual(w.document.querySelector('#vlRestore').style.display, 'none');
  w.document.querySelector('#vlRPass').value = 'wrong-password';
  w.document.querySelector('#vlRestore').click();
  await waitFor(() => w.document.body.textContent.includes('口令不对'));
  assert.notEqual(w.document.querySelector('#vlRestore').style.display, 'none');
  w.document.querySelector('#vlRPass').value = 'password123';
  w.document.querySelector('#vlRestore').click();
  await waitFor(() => w.document.body.textContent.includes('恢复完成'));
  assert.equal(merged, 1);
  assert.equal(reads, 2);
  w.Vault.openLocalSheet();
  assert.equal(w.document.querySelector('#vlRestore').style.display, 'none', 'a new panel session releases the selected file');
  dom.window.close();
});

