/**
 * 反共享机制配置
 * 所有关键参数集中管理，方便测试和调整
 */

// ============================================
// 反共享核心配置
// ============================================
export const ANTI_SHARE_CONFIG = {
  // 设备限制
  MAX_DEVICES: 4,              // 最大设备数量（测试建议：2）
  CITY_CHECK_START_INDEX: 2,  // 前N台设备是基线，从第N+1台开始检测城市（1=第1台是基线，从第2台开始检测；2=前2台是基线，从第3台开始检测）
  
  // 城市限制
  MAX_CITIES: 5,               // 账户最大城市数量，达到上限后，已存在设备访问新城市会被拒绝（测试建议：3-5）
  
  // 访问次数限制（可选功能，默认关闭）
  RATE_LIMIT_ENABLED: true,   // 是否启用访问次数限制
  RATE_LIMITS: {
    1: 3,   // 1台设备：2次/天（测试建议：2-3次）
    2: 5,   // 2台设备：4次/天（测试建议：4-5次）
    3: 7,   // 3台设备：6次/天
    4: 9    // 4台设备：8次/天
  },
  
  // 账号临时封禁（悬挂）配置 - 用于检测账号共享行为
  SUSPEND_ENABLED: true,                          // 是否启用临时封禁机制
  SUSPEND_REQUIRE_MAX_DEVICES: false,             // 是否要求设备数达到上限才触发封禁（测试：false，生产：false）
  SUSPEND_DURATION_DAYS: 7,                       // 封禁时长（天）
  
  // 两种封禁触发条件（满足任一即触发）：
  SUSPEND_RATE_LIMIT_ATTEMPTS_THRESHOLD: 10,      // 达到每日上限后，失败访问次数阈值（正常用户达到上限不会继续访问，但共享账号会有多人尝试）
  SUSPEND_FAILED_ATTEMPTS_THRESHOLD: 5            // 其他失败尝试阈值（如新设备新城市等，防止恶意刷新）
};

// ============================================
// 批量生成配置
// ============================================
export const BATCH_GENERATE_CONFIG = {
  MAX_TOKENS_PER_BATCH: 10,  // 单次最多生成数量（测试建议：10）
  MIN_TOKENS_PER_BATCH: 1,     // 单次最少生成数量
  TOKEN_LENGTH: 4,              // Token长度（测试建议：4-6）
  TOKEN_CHARSET: 'abcdefghijklmnopqrstuvwxyz0123456789',  // Token字符集
  
  // 默认有效期（天）
  // 常用值参考：
  //   1分钟 = 1/1440 (约 0.000694)
  //   5分钟 = 5/1440 (约 0.003472)
  //   1小时 = 1/24 (约 0.041667)
  //   1天 = 1
  //   30天 = 30
  DEFAULT_DURATION_DAYS: 1/1440,    // 默认有效期：1分钟（测试用）
  MAX_DURATION_DAYS: 3650           // 最大有效期（10年）
};

// ============================================
// 数据清理配置
// ============================================
export const CLEANUP_CONFIG = {
  EXPIRED_GRACE_PERIOD_DAYS: 0,   // 过期后保留多少天再清理（测试建议：0天即立即清理）
  CITY_EXPIRY_DAYS: 180,           // 城市记录过期天数，超过此天数未访问的城市会被清理（测试建议：禁用）
  ENABLE_CITY_EXPIRY: false        // 是否启用城市记录过期清理
};

// ============================================
// 城市数据配置
// ============================================
export const CITY_CONFIG = {
  // 城市名称标准化（统一转小写）
  NORMALIZE_CASE: true,
  
  // 是否记录城市访问统计
  ENABLE_CITY_STATS: true,
  
  // 最多记录多少个城市（防止无限增长）（0=不限制）
  MAX_CITIES_PER_DEVICE: 1  // 测试建议：5
};

// ============================================
// GeoIP API 配置
// ============================================
export const GEOIP_CONFIG = {
  // API优先级顺序
  API_PRIORITY: [
    'ipgeolocation.io',      // 1. ipdata.co（最优先）
    'ipwhois.io',     // 2. ipwhois.io
    'ip-api.com',     // 3. ip-api.com
    'ipdata.co', // 4. ipgeolocation.io（降级）
    'cloudflare'      // 5. Cloudflare（最后降级）
  ],
  
  // API请求超时时间（毫秒）
  API_TIMEOUT_MS: 3000,  // 测试建议：1000（更快失败）
  
  // 提取城市字段名（不同API字段名可能不同）
  CITY_FIELD_NAMES: ['city', 'City', 'CITY']
};

// ============================================
// Telegram 通知配置
// ============================================
export const TELEGRAM_CONFIG = {
  NOTIFY_ON_ACTIVATION: true,        // 是否发送激活通知
  NOTIFY_ON_NEW_DEVICE: true,        // 是否发送新设备绑定成功通知
  NOTIFY_ON_DEVICE_LIMIT: true,      // 是否发送设备数超限通知
  NOTIFY_ON_CITY_MISMATCH: true,     // 是否发送城市不匹配通知
  NOTIFY_ON_RATE_LIMIT: true         // 是否发送访问次数超限通知
};

// ============================================
// Bot 检测配置（防止链接预览导致意外激活）
// ============================================
export const BOT_DETECTION_CONFIG = {
  ENABLED: true,                   // 是否启用Bot检测
  // Bot User-Agent关键词（忽略大小写）
  BOT_KEYWORDS: [
    'bot',                          // TelegramBot, DiscordBot等
    'crawler',                      // 爬虫
    'spider',                       // 搜索引擎爬虫
    'preview',                      // 链接预览
    'fetch',                        // 预取
    'headless',                     // 无头浏览器
    'phantomjs',                    // PhantomJS
    'curl',                         // Curl（可选，根据需要开启）
    'wget'                          // Wget（可选，根据需要开启）
  ]
};

// ============================================
// 测试模式配置
// ============================================
export const TEST_MODE = {
  // 是否启用测试模式（会输出更多日志）
  ENABLED: false,
  
  // 测试模式下的快捷配置
  QUICK_CONFIG: {
    MAX_DEVICES: 2,
    TOKEN_LENGTH: 4,
    MAX_TOKENS_PER_BATCH: 10,
    DEFAULT_DURATION_DAYS: 1,  // 1天
    RATE_LIMITS: { 1: 3, 2: 5 }
  }
};

// ============================================
// 辅助函数：获取当前配置
// ============================================
export function getConfig() {
  if (TEST_MODE.ENABLED) {
    return {
      antiShare: {
        ...ANTI_SHARE_CONFIG,
        MAX_DEVICES: TEST_MODE.QUICK_CONFIG.MAX_DEVICES,
        RATE_LIMITS: TEST_MODE.QUICK_CONFIG.RATE_LIMITS
      },
      batchGenerate: {
        ...BATCH_GENERATE_CONFIG,
        TOKEN_LENGTH: TEST_MODE.QUICK_CONFIG.TOKEN_LENGTH,
        MAX_TOKENS_PER_BATCH: TEST_MODE.QUICK_CONFIG.MAX_TOKENS_PER_BATCH,
        DEFAULT_DURATION_DAYS: TEST_MODE.QUICK_CONFIG.DEFAULT_DURATION_DAYS
      },
      cleanup: CLEANUP_CONFIG,
      city: CITY_CONFIG,
      geoip: GEOIP_CONFIG,
      telegram: TELEGRAM_CONFIG,
      botDetection: BOT_DETECTION_CONFIG
    };
  }
  
  return {
    antiShare: ANTI_SHARE_CONFIG,
    batchGenerate: BATCH_GENERATE_CONFIG,
    cleanup: CLEANUP_CONFIG,
    city: CITY_CONFIG,
    geoip: GEOIP_CONFIG,
    telegram: TELEGRAM_CONFIG,
    botDetection: BOT_DETECTION_CONFIG
  };
}

// ============================================
// 导出默认配置
// ============================================
export default getConfig();
