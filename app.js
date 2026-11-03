const cfg = require('./utils/config.js');
const store = require('./utils/store.js');

const CLOUD_ENABLED = !!(cfg && cfg.ENV_ID && cfg.ENV_ID.indexOf('REPLACE') < 0);

App({
  onLaunch() {
    if (CLOUD_ENABLED && wx.cloud) {
      // traceUser 关闭：不静默上报用户 openid，最小化数据采集，与业务功能无关
      wx.cloud.init({ env: cfg.ENV_ID, traceUser: false });
    }
    // 预热本地目录（本地兜底模式使用）；并异步拉取云端/本地记录到缓存
    store.ensureDir();
    store.init()
      .then(() => store.cleanupExpired().catch(() => {}))
      .catch(() => {});
  },
  globalData: {
    version: '2.5',
    cloudEnabled: CLOUD_ENABLED
  }
});
