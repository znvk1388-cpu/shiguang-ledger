# 拾光记账｜GitHub 产品细节对标

依据公开项目官方介绍和文档以及拾光当前本地源码整理；未实测竞品。建议借鉴产品思路，不复制源代码。

## 对标项目与许可

- [FlyBudget](https://github.com/dtymoszenko/FlyBudget)：记账与预算项目，AGPL-3.0-only，GitHub API 显示未归档，最近推送 2026-10-26。直接复用代码前需核查完整许可义务。
- [Cashew](https://github.com/jameskokoska/Cashew)：跨端记账项目，GPL-3.0，未归档，GitHub API 显示最近推送 2026-03-09。可参考交互，不直接复制源码。
- [ezBookkeeping](https://github.com/mayswind/ezbookkeeping)：MIT，面向多地区与多格式的记账项目，导入能力和细节可参考其[发布记录](https://github.com/mayswind/ezbookkeeping/releases)。

## 对照与建议

1. **规则预览更具体**：[FlyBudget](https://github.com/dtymoszenko/FlyBudget)支持规则预览及对历史交易运行前预览。拾光 `js/smart.js` 已预览影响数量、前 20 笔和修改内容；可进一步显示分类、账户的修改前后，保存失败或冲突时保留结果明细。批量回刷的跨账号、账本切换需保护，已发起代码复核。
2. **周期账单的信息表达**：[Cashew 指引](https://cashewapp.web.app/faq.html)区分计划日期和标记支付后的日期，提供跳过当前周期。拾光 `js/manage.js` 已有到期视图和跳过本期，可核对补记显示的日期、逾期状态和“跳过不删除历史账目”的说明；自动补记行为不能未经设计改成手动支付。
3. **批量回刷失败后可追踪**：[FlyBudget](https://github.com/dtymoszenko/FlyBudget)将规则影响与交易预览结合。拾光目前通过 toast 提示成功/冲突/失败数量后关闭面板；可考虑持久展示成功及冲突记录，避免用户错过短暂提示。不得在网络结果不明时盲目再次写入。
4. **备注输入反馈**：[ezBookkeeping 版本记录](https://github.com/mayswind/ezbookkeeping/releases)提供交易描述长度反馈。拾光编辑器已将备注限制为 80 字；可在接近限制时展示剩余字数，并为辅助设备提供明确标签，避免重复添加限制或改变旧数据。
5. **未来可考虑旅行等一次性预算**：[Cashew README](https://github.com/jameskokoska/Cashew)支持自定义预算周期。拾光已有月/周/年预算，旅行预算需要单独的数据模型与同步兼容设计，不适合直接套用常规月预算。

2026-10-29 依据 GitHub API 校验维护状态；来源事实可能随时间变化。功能差异基于代码静态阅读，真实手机、实际云端和竞品未实测。
