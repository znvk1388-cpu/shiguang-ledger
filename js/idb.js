/* 极简 IndexedDB 封装：游客模式的本地数据层 */
window.Idb = (function () {
  const DB_NAME = 'ledger10-guest'
  const VERSION = 4
  const STORES = ['accounts', 'categories', 'transactions', 'attachments', 'budgets', 'recurring', 'books', 'goals', 'templates', 'metadata']
  let dbPromise = null

  function open() {
    if (dbPromise) return dbPromise
    const pending = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      let cancelled = false
      req.onupgradeneeded = () => {
        const db = req.result
        STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id', autoIncrement: true })
          }
        })
      }
      req.onsuccess = () => {
        const db = req.result
        /* blocked 已报错后请求仍可能完成；关闭迟到连接，避免它继续挡住升级。 */
        if (cancelled) { db.close(); return }
        db.onversionchange = () => {
          db.close()
          if (dbPromise === pending) dbPromise = null
        }
        resolve(db)
      }
      req.onblocked = () => {
        cancelled = true
        if (dbPromise === pending) dbPromise = null
        reject(new Error('本机数据库升级被其他标签页阻止，请关闭本应用的其他标签页后重试'))
      }
      req.onerror = () => {
        if (dbPromise === pending) dbPromise = null
        reject(req.error)
      }
    })
    dbPromise = pending
    return pending
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
    if (!map || typeof map !== 'object' || Array.isArray(map)) return Promise.reject(new Error('备份数据格式不正确'))
    const stores = Object.keys(map)
    if (stores.some(s => STORES.indexOf(s) < 0 || !Array.isArray(map[s]))) return Promise.reject(new Error('备份数据表格式不正确'))
    return open().then(db => new Promise((resolve, reject) => {
      if (!stores.length) { resolve(true); return }
      const transaction = db.transaction(stores, 'readwrite')
      let writeError = null
      transaction.oncomplete = () => resolve(true)
      transaction.onabort = () => reject(writeError || transaction.error || new Error('本机存储未提交，原数据未受影响，请重试或改用导出文件恢复'))
      /* DataError / DataCloneError 会同步抛出，不会自动中止已经排队的 clear。
         只有显式 abort 才能保证所有表仍是恢复前的内容。 */
      try {
        stores.forEach(s => {
          const os = transaction.objectStore(s)
          os.clear()
          for (const row of map[s]) os.put(row)
        })
      } catch (e) {
        writeError = e
        transaction.abort()
      }
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

