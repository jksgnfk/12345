const cfg = require('./utils/config.js');
const store = require('./utils/store.js');

const CLOUD_ENABLED = !!(cfg && cfg.ENV_ID && cfg.ENV_ID.indexOf('REPLACE') < 0);

App({
  onLaunch() {
    if (CLOUD_ENABLED && wx.cloud) {
      wx.cloud.init({ env: cfg.ENV_ID, traceUser: true });
    }
    // 预热本地目录（本地兜底模式使用）；并异步拉取云端/本地记录到缓存
    store.ensureDir();
    store.init();
  },
  globalData: {
    version: '2.5',
    cloudEnabled: CLOUD_ENABLED
  }
});
