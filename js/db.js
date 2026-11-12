/* 统一数据门面：游客（本地 IndexedDB）与云端两个后端共用一套接口；
   UI 只认 window.DB，绑定时执行一键迁移 */
window.DB = (function () {
  let backend = window.GuestStore
  const api = { mode: 'guest' }

  const METHODS = [
    'init', 'seedPresets',
    'accounts', 'allAccounts', 'accountName', 'categoryName', 'category', 'rootCategories', 'childCategories',
    'addAccount', 'updateAccount', 'deleteAccount', 'addCategory', 'updateCategory', 'deleteCategory',
    'listTransactions', 'getTransaction', 'addTransaction', 'updateTransaction', 'deleteTransaction',
    'restoreTransaction', 'purgeTransaction', 'listTemplates', 'addTemplate', 'updateTemplate', 'deleteTemplate',
    'listAttachments', 'addAttachments', 'removeAttachment', 'uploadImage', 'imageUrl',
    'listAllAttachments', 'uploadFile',
    'monthlySummary', 'categorySummary', 'budgetOf', 'setBudget',
    'accountBalances', 'storageUsage', 'exportAll', 'netWorthSeries',
    'listRecurring', 'addRecurring', 'updateRecurring', 'deleteRecurring', 'applyRecurring', 'pendingRecurring',
    'books', 'activeBookId', 'currentBookId', 'defaultBookId', 'setActiveBook', 'bookName',
    'addBook', 'renameBook', 'deleteBook', 'ensureDefaultBook',
    'listGoals', 'addGoal', 'updateGoal', 'deleteGoal', 'goalDeposit',
  ]

  METHODS.forEach(m => {
    api[m] = function () { return backend[m].apply(backend, arguments) }
  })
  Object.defineProperty(api, 'state', {
    get: function () { return backend.state },
  })
  /* 幂等/分页能力只在云端后端存在，单独透出（游客侧返回安全默认值） */
  api.hasOp = function () { return backend.hasOp ? backend.hasOp.apply(backend, arguments) : Promise.resolve(false) }
  api.opTag = function (id) { return backend.opTag ? backend.opTag(id) : ('_op:' + id) }

  /* 本机存储持久化（A1）
     ------------------------------------------------------------------
     游客模式下账目全在 IndexedDB 里，而浏览器在磁盘紧张时会「按需清理」
     整个站点的存储，且不给任何提示。persist() 只是「申请」，是否授予由
     浏览器按站点互动度决定；这里只负责申请并把结果记下来，
     交给「我的 → 备份状态卡」显示，让用户知道自己是不是处于可被清理的状态。 */
  let persisted = null
  async function ensurePersisted() {
    try {
      const sm = typeof navigator !== 'undefined' ? navigator.storage : null
      if (!sm || typeof sm.persist !== 'function') { persisted = false; return persisted }
      if (typeof sm.persisted === 'function') {
        try { if (await sm.persisted()) { persisted = true; return persisted } } catch (e) { /* 继续尝试申请 */ }
      }
      persisted = !!(await sm.persist())
    } catch (e) { persisted = false }
    return persisted
  }
  api.persistState = function () { return persisted }
  api.ensurePersisted = ensurePersisted

  function useGuest() {
    backend = window.GuestStore
    api.mode = 'guest'
    ensurePersisted()          /* 不阻塞启动；失败也不影响记账 */
    return backend.init()
  }

  async function useCloud(session) {
    backend = window.Store
    api.mode = 'cloud'
    ensurePersisted()          /* 云端模式也有一份本机缓存，顺手申请 */
    await backend.init(session.user.id)
  }

  /* 游客数据是否有内容 */
  async function guestHasData() {
    return window.GuestStore.hasData()
  }

  /* 迁移/导入的重活放在懒加载模块 js/migrate.js：
     它只在「登录时发现本机有游客数据」或「从 JSON 备份导入」时才用得上，
     不占首屏体积。这里只做转发，保持调用点语义不变。 */
  function migrator() {
    return window.Lazy.need('migrate').then(m => {
      if (!m) throw new Error('迁移模块加载失败，请检查网络后重试')
      return m
    })
  }

  async function importDumpToCloud(dump, onProgress) {
    const M = await migrator()
    return M.importDumpToCloud(dump, onProgress)
  }

  async function migrateGuestToCloud(session, onProgress) {
    const M = await migrator()
    return M.migrateGuestToCloud(session, onProgress)
  }

  api.useGuest = useGuest
  api.useCloud = useCloud
  api.guestHasData = guestHasData
  api.migrateGuestToCloud = migrateGuestToCloud
  api.importDumpToCloud = importDumpToCloud

  return api
})()
