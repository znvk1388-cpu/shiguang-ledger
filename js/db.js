/* 统一数据门面：游客（本地 IndexedDB）与云端两个后端共用一套接口；
   UI 只认 window.DB，绑定时执行一键迁移 */
window.DB = (function () {
  let backend = window.GuestStore
  const api = { mode: 'guest' }

  const METHODS = [
    'init', 'seedPresets',
    'accounts', 'allAccounts', 'accountName', 'categoryName', 'category', 'rootCategories', 'childCategories',
    'addAccount', 'updateAccount', 'deleteAccount', 'addCategory', 'deleteCategory',
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

  function useGuest() {
    backend = window.GuestStore
    api.mode = 'guest'
    return backend.init()
  }

  async function useCloud(session) {
    backend = window.Store
    api.mode = 'cloud'
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
