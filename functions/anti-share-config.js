/**
 * 反共享机制配置
 * 所有关键参数集中管理，方便调整
 */

// ============================================
// 反共享核心配置
// ============================================
export const ANTI_SHARE_CONFIG = {
  // 设备限制
  MAX_DEVICES: 4,                  // 最大设备数量
  CITY_CHECK_START_INDEX: 2,       // 从第N+1台开始检测城市（1=第1台是基线，从第2台开始检测）
  
  // 城市限制
  MAX_CITIES: 5,                   // 账户最大城市数量，达到上限后，已存在设备访问新城市会被拒绝
  
  // 访问次数限制
  RATE_LIMIT_ENABLED: true,        // 是否启用访问次数限制
  RATE_LIMITS: {
    1: 50,    // 1台设备：50次/天
    2: 80,    // 2台设备：80次/天
    3: 100,   // 3台设备：100次/天
    4: 120    // 4台设备：120次/天
  },
  
  // 账号临时封禁配置 - 用于检测账号共享行为
  SUSPEND_ENABLED: true,                          // 是否启用临时封禁机制
  SUSPEND_REQUIRE_MAX_DEVICES: false,             // 是否要求设备数达到上限才触发封禁
  SUSPEND_DURATION_DAYS: 7,                       // 封禁时长（天）
  
  // 封禁触发条件（满足任一即触发）：
  SUSPEND_RATE_LIMIT_ATTEMPTS_THRESHOLD: 10,      // 达到每日上限后，继续尝试访问次数阈值（共享账号会有多人尝试）
  SUSPEND_FAILED_ATTEMPTS_THRESHOLD: 5            // 其他失败尝试阈值（如新设备新城市、设备数超限等）
};

// ============================================
// 批量生成配置
// ============================================
export const BATCH_GENERATE_CONFIG = {
  MAX_TOKENS_PER_BATCH: 100,        // 单次最多生成数量
  MIN_TOKENS_PER_BATCH: 1,          // 单次最少生成数量
  TOKEN_LENGTH: 4,                  // Token长度
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
// GeoIP API 配置
// ============================================
export const GEOIP_CONFIG = {
  // API优先级顺序
  API_PRIORITY: [
    'ipgeolocation.io',      // 1. ipgeolocation.io（推荐）
    'ipwhois.io',            // 2. ipwhois.io
    'ip-api.com',            // 3. ip-api.com
    'ipdata.co',             // 4. ipdata.co
    'cloudflare'             // 5. Cloudflare（最后降级）
  ],
  API_TIMEOUT_MS: 5000       // API请求超时时间（毫秒）
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
// 辅助函数：获取当前配置
// ============================================
export function getConfig() {
  return {
    antiShare: ANTI_SHARE_CONFIG,
    batchGenerate: BATCH_GENERATE_CONFIG,
    geoip: GEOIP_CONFIG,
    telegram: TELEGRAM_CONFIG,
    botDetection: BOT_DETECTION_CONFIG
  };
}

// ============================================
// 导出默认配置
// ============================================
export default getConfig();
