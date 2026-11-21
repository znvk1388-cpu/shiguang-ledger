# TWA 打包 APK · 作业清单（Bubblewrap）

前提：App 本体已有 HTTPS 部署地址（见 README.md 部署步骤）。TWA 是把 PWA 原样装进一个极小的安卓壳，所有界面仍由你的 HTTPS 页面渲染。

## 0. 需要的东西

- Node.js 18+（本机已有）
- Bubblewrap 会自动下载 JDK 与 Android SDK 到用户目录（约 400MB，首次 init 时进行）
- 一个用于签名的 keystore（一次性生成，**永久保管**：丢失将无法更新同一应用）

## 1. 生成签名密钥（只做一次，仓库外保管）

```bash
keytool -genkeypair -v -keystore shiguang-release.keystore -alias shiguang \
  -keyalg RSA -keysize 2048 -validity 10950
# 建议保存位置：D:\codex\workspace\backups\shiguang-ledger-android\
# 口令记入密码管理器；丢失 keystore = 永远不能再发这个包名的更新
```

## 2. 初始化 TWA 工程

```bash
npx @bubblewrap/cli init --manifest https://<你的部署地址>/manifest.json
# 交互确认：包名建议 com.shiguangji.ledger；签名指向第 1 步的 keystore
```

## 3. 构建 APK / AAB

```bash
npx @bubblewrap/cli build --skipPwaValidation
# 产物：app-release-signed.apk（直发用）与 app-release-bundle.aab（Google Play 用）
```

- **直发（路径 A）**：把 APK 上传到官网/对象存储，官网「下载安卓 APK」按钮指向它。
- **Google Play（路径 C）**：用 AAB + $25 开发者账号。
- 直发 APK 没有 Play 的资产校验，需要在部署域名放 `/.well-known/assetlinks.json`（bubblewrap build 末尾会打印内容与指纹），否则打开时会显示浏览器地址栏——照做即可去掉。

## 4. 发版前核对

- [ ] manifest.json 的 name/short_name/theme_color/start_url 正确（改了要重新 init/build）
- [ ] icon-512.png 与 maskable 图标已就位（仓库已有）
- [ ] 版本号：`bubblewrap update` 会同步 package.json 版本；每次发版先在 repo 升版本并 `npm run stamp`
- [ ] APK 在真机安装验证：记账、备份、激活码、触感反馈（Android 有效）

## 5. 常见坑

- 手机默认拦「未知来源安装」：官网下载页加一句引导文案（设置里允许该浏览器安装）。
- 部署地址必须 HTTPS 且证书有效，否则 TWA 白屏。
- `--skipPwaValidation` 仅用于直发快速验证；正式 Google Play 提审时去掉并确保 assetlinks 就绪。
