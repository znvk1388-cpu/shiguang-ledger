/* 极简 IndexedDB 封装：游客模式的本地数据层 */
window.Idb = (function () {
  const DB_NAME = 'ledger10-guest'
  const VERSION = 3
  const STORES = ['accounts', 'categories', 'transactions', 'attachments', 'budgets', 'recurring', 'books', 'goals', 'templates']
  let dbPromise = null

  function open() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id', autoIncrement: true })
          }
        })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbPromise
  }

  function tx(db, store, mode) {
    return db.transaction(store, mode).objectStore(store)
  }

  function all(store) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = tx(db, store, 'readonly').getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    }))
  }

  /* 只数条数，不取值：attachments 里全是图片 Blob，getAll 会把几百 MB 读进内存 */
  function count(store) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = tx(db, store, 'readonly').count()
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => reject(req.error)
    }))
  }

  function get(store, id) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = tx(db, store, 'readonly').get(id)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    }))
  }

  function put(store, row) {
    return write(store, objectStore => objectStore.put(row))
  }

  function add(store, row) {
    return write(store, objectStore => objectStore.add(row))
  }

  function del(store, id) {
    return write(store, objectStore => objectStore.delete(id), true)
  }

  function clear(store) {
    return write(store, objectStore => objectStore.clear(), true)
  }

  /* 多表原子替换：恢复备份专用（P0 修复）。
     旧实现 restore 是「先 deleteDatabase 毁库、再逐行写回」，中途失败 =
     本机全部数据不可逆丢失。这里把所有 store 的 clear+put 放进同一个事务：
     任一 store 写失败整体回滚，恢复前的数据原样保留。 */
  function replaceAll(map) {
    return open().then(db => new Promise((resolve, reject) => {
      const stores = Object.keys(map)
      if (!stores.length) { resolve(true); return }
      const transaction = db.transaction(stores, 'readwrite')
      stores.forEach(s => {
        const os = transaction.objectStore(s)
        os.clear()
        const rows = map[s] || []
        for (let i = 0; i < rows.length; i++) os.put(rows[i])
      })
      transaction.oncomplete = () => resolve(true)
      transaction.onabort = () => reject(transaction.error || new Error('本机存储未提交，原数据未受影响，请重试或改用导出文件恢复'))
      transaction.onerror = () => reject(transaction.error || new Error('本机存储失败，原数据未受影响'))
    }))
  }

  // A request can succeed before its transaction aborts (quota / disk failure).
  // Only a completed transaction is a durable successful write.
  function write(store, operation, fixedResult) {
    return open().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite')
      const req = operation(transaction.objectStore(store))
      transaction.oncomplete = () => resolve(fixedResult === undefined ? req.result : fixedResult)
      transaction.onabort = () => reject(transaction.error || req.error || new Error('本机存储未提交，请重试或导出备份'))
      transaction.onerror = () => reject(transaction.error || req.error || new Error('本机存储失败'))
    }))
  }

  function destroy() {
    return open().then(db => {
      db.close()
      dbPromise = null
      return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(DB_NAME)
        req.onsuccess = () => resolve(true)
        req.onerror = () => reject(req.error)
      })
    })
  }

  return { all, count, get, put, add, del, clear, replaceAll, destroy, STORES }
})()
