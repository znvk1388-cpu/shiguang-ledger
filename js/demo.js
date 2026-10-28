/* 示例预览仅展示虚构数据，不访问或写入用户账本。 */
;(function () {
  'use strict'
  function openDemoData() {
    const U = window.UI
    U.openSheet(
      '<div class="sheet-head"><span class="sheet-title">记账示例预览</span><button id="dmClose" class="btn sm line">关闭</button></div>' +
      '<p class="small muted">以下是虚构数据，仅供预览，不会写入或修改你的账本。</p>' +
      '<div class="card"><b>本月收支</b><div class="kv"><span>收入</span><b>¥5,000.00</b></div>' +
      '<div class="kv"><span>支出</span><b>¥2,180.00</b></div><div class="kv"><span>结余</span><b>¥2,820.00</b></div></div>' +
      '<div class="card"><b>最近记录</b><div class="kv"><span>午餐 · 餐饮</span><span>−¥25.00</span></div>' +
      '<div class="kv"><span>地铁 · 交通</span><span>−¥6.00</span></div>' +
      '<div class="kv"><span>工资 · 收入</span><span>+¥5,000.00</span></div></div>' +
      '<div class="card"><b>预算示例</b><p class="small muted">本月预算 ¥3,000.00，已支出 ¥2,180.00。</p></div>'
    )
    U.$('#dmClose').addEventListener('click', U.closeSheet)
  }
  window.Demo = { openDemoData }
})()
