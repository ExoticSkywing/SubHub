import yaml from 'js-yaml';
import { StorageFactory, DataMigrator, STORAGE_TYPES } from './storage-adapter.js';
import { getConfig, resolveAntiShareConfig } from './anti-share-config.js';

/**
 * 修复Clash配置中的WireGuard问题
 * @param {string} content - Clash配置内容
 * @returns {string} - 修复后的配置内容
 */
function clashFix(content) {
    if (content.includes('wireguard') && !content.includes('remote-dns-resolve')) {
        let lines;
        if (content.includes('\r\n')) {
            lines = content.split('\r\n');
        } else {
            lines = content.split('\n');
        }

        let result = "";
        for (let line of lines) {
            if (line.includes('type: wireguard')) {
                const 备改内容 = `, mtu: 1280, udp: true`;
                const 正确内容 = `, mtu: 1280, remote-dns-resolve: true, udp: true`;
                result += line.replace(new RegExp(备改内容, 'g'), 正确内容) + '\n';
            } else {
                result += line + '\n';
            }
        }
        return result;
    }
    return content;
}

const OLD_KV_KEY = 'misub_data_v1';
const KV_KEY_SUBS = 'misub_subscriptions_v1';
const KV_KEY_PROFILES = 'misub_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const COOKIE_NAME = 'auth_session';
const DEFAULT_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function getSessionDurationMs(env) {
    const msRaw = env.ADMIN_SESSION_DURATION_MS;
    if (msRaw !== undefined && msRaw !== null && msRaw !== '') {
        const ms = Number(msRaw);
        if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);
    }

    const daysRaw = env.ADMIN_SESSION_DAYS;
    if (daysRaw !== undefined && daysRaw !== null && daysRaw !== '') {
        const days = Number(daysRaw);
        if (Number.isFinite(days) && days > 0) return Math.floor(days * 24 * 60 * 60 * 1000);
    }

    return DEFAULT_SESSION_DURATION_MS;
}

/**
 * 计算数据的简单哈希值，用于检测变更
 * @param {any} data - 要计算哈希的数据
 * @returns {string} - 数据的哈希值
 */
function calculateDataHash(data) {
    const jsonString = JSON.stringify(data, Object.keys(data).sort());
    let hash = 0;
    for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // 转换为32位整数
    }
    return hash.toString();
}

/**
 * 检测数据是否发生变更
 * @param {any} oldData - 旧数据
 * @param {any} newData - 新数据
 * @returns {boolean} - 是否发生变更
 */
function hasDataChanged(oldData, newData) {
    if (!oldData && !newData) return false;
    if (!oldData || !newData) return true;
    return calculateDataHash(oldData) !== calculateDataHash(newData);
}

/**
 * 条件性写入KV存储，只在数据真正变更时写入
 * @param {Object} env - Cloudflare环境对象
 * @param {string} key - KV键名
 * @param {any} newData - 新数据
 * @param {any} oldData - 旧数据（可选）
 * @returns {Promise<boolean>} - 是否执行了写入操作
 */
async function conditionalKVPut(env, key, newData, oldData = null) {
    // 如果没有提供旧数据，先从KV读取
    if (oldData === null) {
        try {
            oldData = await env.MISUB_KV.get(key, 'json');
        } catch (error) {
            // 读取失败时，为安全起见执行写入
            await env.MISUB_KV.put(key, JSON.stringify(newData));
            return true;
        }
    }

    // 检测数据是否变更
    if (hasDataChanged(oldData, newData)) {
        await env.MISUB_KV.put(key, JSON.stringify(newData));
        return true;
    } else {
        return false;
    }
}

// {{ AURA-X: Add - 批量写入优化机制. Approval: 寸止(ID:1735459200). }}
/**
 * 批量写入队列管理器
 */
class BatchWriteManager {
    constructor() {
        this.writeQueue = new Map(); // key -> {data, timestamp, resolve, reject}
        this.debounceTimers = new Map(); // key -> timerId
        this.DEBOUNCE_DELAY = 1000; // 1秒防抖延迟
    }

    /**
     * 添加写入任务到队列，使用防抖机制
     * @param {Object} env - Cloudflare环境对象
     * @param {string} key - KV键名
     * @param {any} data - 要写入的数据
     * @param {any} oldData - 旧数据（用于变更检测）
     * @returns {Promise<boolean>} - 是否执行了写入
     */
    async queueWrite(env, key, data, oldData = null) {
        return new Promise((resolve, reject) => {
            // 清除之前的定时器
            if (this.debounceTimers.has(key)) {
                clearTimeout(this.debounceTimers.get(key));
            }

            // 更新队列中的数据
            this.writeQueue.set(key, {
                data,
                oldData,
                timestamp: Date.now(),
                resolve,
                reject
            });

            // 设置新的防抖定时器
            const timerId = setTimeout(async () => {
                await this.executeWrite(env, key);
            }, this.DEBOUNCE_DELAY);

            this.debounceTimers.set(key, timerId);
        });
    }

    /**
     * 执行实际的写入操作
     * @param {Object} env - Cloudflare环境对象
     * @param {string} key - KV键名
     */
    async executeWrite(env, key) {
        const writeTask = this.writeQueue.get(key);
        if (!writeTask) return;

        // 清理定时器
        if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key));
            this.debounceTimers.delete(key);
        }

        try {
            const wasWritten = await conditionalKVPut(env, key, writeTask.data, writeTask.oldData);
            writeTask.resolve(wasWritten);
        } catch (error) {
            writeTask.reject(error);
        } finally {
            // 清理队列
            this.writeQueue.delete(key);
        }
    }

    /**
     * 立即执行所有待写入的任务（用于紧急情况）
     * @param {Object} env - Cloudflare环境对象
     */
    async flushAll(env) {
        const keys = Array.from(this.writeQueue.keys());
        const promises = keys.map(key => this.executeWrite(env, key));
        await Promise.allSettled(promises);
    }
}

// 全局批量写入管理器实例
const batchWriteManager = new BatchWriteManager();

/**
 * 获取存储适配器实例
 * @param {Object} env - Cloudflare 环境对象
 * @returns {Promise<Object>} 存储适配器实例
 */
async function getStorageAdapter(env) {
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

/**
 * 处理配置的向后兼容性，确保新的前缀配置结构存在
 * @param {Object} config - 原始配置对象
 * @returns {Object} - 处理后的配置对象
 */
function migrateConfigSettings(config) {
    const migratedConfig = { ...config };
    
    // 如果没有新的 prefixConfig，但有老的 prependSubName，则创建默认的 prefixConfig
    if (!migratedConfig.prefixConfig) {
        const fallbackEnabled = migratedConfig.prependSubName ?? true;
        migratedConfig.prefixConfig = {
            enableManualNodes: fallbackEnabled,
            enableSubscriptions: fallbackEnabled,
            manualNodePrefix: '手动节点'
        };
    }
    
    // 确保 prefixConfig 的所有字段都存在
    if (!migratedConfig.prefixConfig.hasOwnProperty('enableManualNodes')) {
        migratedConfig.prefixConfig.enableManualNodes = migratedConfig.prependSubName ?? true;
    }
    if (!migratedConfig.prefixConfig.hasOwnProperty('enableSubscriptions')) {
        migratedConfig.prefixConfig.enableSubscriptions = migratedConfig.prependSubName ?? true;
    }
    if (!migratedConfig.prefixConfig.hasOwnProperty('manualNodePrefix')) {
        migratedConfig.prefixConfig.manualNodePrefix = '手动节点';
    }
    
    return migratedConfig;
}

// --- [新] 默认设置中增加通知阈值和存储类型 ---
const defaultSettings = {
  FileName: 'SUBHUB',
  mytoken: 'auto',
  profileToken: 'profiles',
  adminKey: '', // 管理员密钥，用于访问二段式订阅链接
  subConverter: 'url.v1.mk',
  subConfig: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/refs/heads/main/Clash/config/ACL4SSR_Online_Full.ini',
  prependSubName: true, // 保持向后兼容
  prefixConfig: {
    enableManualNodes: true,    // 手动节点前缀开关
    enableSubscriptions: true,  // 机场订阅前缀开关
    manualNodePrefix: '手动节点', // 手动节点前缀文本
  },
  NotifyThresholdDays: 3,
  NotifyThresholdPercent: 90,
  storageType: 'kv', // 数据存储类型，默认 KV，可选 'd1'
  IPGeoAPIKey: '', // ipgeolocation.io API Key（最精准，1000次/天）
  IPDataAPIKey: '' // ipdata.co API Key（准确，1500次/天）
};

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes || bytes < 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // toFixed(dm) after dividing by pow(k, i) was producing large decimal numbers
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return '0 B'; // Handle log(0) case
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// 将流量字符串转换为字节数（例如 "10GB" -> 10737418240）
const parseBandwidthToBytes = (bandwidthStr) => {
  if (!bandwidthStr || typeof bandwidthStr !== 'string') {
    return 10737418240; // 默认 10GB
  }
  
  const str = bandwidthStr.trim().toUpperCase();
  // 支持 G、GB、T、TB 等简写和全写
  const match = str.match(/^([\d.]+)\s*([KMGTPB]+)?$/);
  
  if (!match) {
    return 10737418240; // 默认 10GB
  }
  
  const value = parseFloat(match[1]);
  let unit = (match[2] || 'B').toUpperCase();
  const k = 1024;
  
  // 规范化单位（处理 G -> GB, T -> TB 等）
  const unitMap = {
    'B': 1,
    'K': k,
    'KB': k,
    'M': k * k,
    'MB': k * k,
    'G': k * k * k,
    'GB': k * k * k,
    'T': k * k * k * k,
    'TB': k * k * k * k,
    'P': k * k * k * k * k,
    'PB': k * k * k * k * k
  };
  
  return Math.floor(value * (unitMap[unit] || 1));
};

// --- TG 通知函式 (无修改) ---
async function sendTgNotification(settings, message) {
  if (!settings.BotToken || !settings.ChatID) {
    return false;
  }
  
  // 为所有消息添加时间戳
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;
  
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  const payload = { 
    chat_id: settings.ChatID, 
    text: fullMessage, 
    parse_mode: 'Markdown',
    disable_web_page_preview: true // 禁用链接预览，使消息更紧凑
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

/**
 * 将国家代码转换为国旗 emoji
 * @param {string} countryCode - 国家代码（如 CN, US, JP）
 * @returns {string} - 国旗 emoji（如 🇨🇳, 🇺🇸, 🇯🇵）
 */
function getCountryEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

/**
 * 生成随机用户Token
 * @param {number} length - Token长度
 * @returns {string} - 随机Token
 */
function generateRandomToken(length) {
  const config = getConfig();
  const charset = config.batchGenerate.TOKEN_CHARSET;
  let token = '';
  for (let i = 0; i < length; i++) {
    token += charset[Math.floor(Math.random() * charset.length)];
  }
  return token;
}

/**
 * 生成唯一的用户Token（确保不与现有Token冲突）
 * @param {Object} env - Cloudflare环境对象
 * @param {number} length - Token长度
 * @returns {Promise<string>} - 唯一Token
 */
async function generateUniqueUserToken(env, length) {
  let token;
  let attempts = 0;
  const maxAttempts = 100;
  
  do {
    token = generateRandomToken(length);
    const storageAdapter = await getStorageAdapter(env);
    const exists = await storageAdapter.get(`user:${token}`);
    if (!exists) {
      return token;
    }
    attempts++;
  } while (attempts < maxAttempts);
  
  throw new Error('无法生成唯一Token，请稍后重试');
}

/**
 * 发送增强版Telegram通知，包含IP地理位置信息
 * @param {Object} settings - 设置对象
 * @param {string} type - 通知类型
 * @param {Request} request - Cloudflare Workers Request 对象
 * @param {string} additionalData - 额外数据
 * @param {string} cityFromCaller - 【可选】调用方已获取的城市信息，避免重复调用 GeoIP API
 * @returns {Promise<boolean>} - 是否发送成功
 */
async function sendEnhancedTgNotification(settings, type, request, additionalData = '', cityFromCaller = null) {
  if (!settings.BotToken || !settings.ChatID) {
    return false;
  }
  
  // 使用与 performAntiShareCheck 相同的 IP 获取逻辑（多层降级）
  const clientIp = request.headers.get('CF-Connecting-IP') 
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || request.headers.get('X-Real-IP')
    || 'N/A';
  let locationInfo = '';
  let geoSource = 'unknown';
  
  // 【复用】如果调用方已经获取了城市信息，直接使用，不重复调用 API
  if (cityFromCaller) {
    locationInfo = `
*城市:* \`${cityFromCaller}\``;
    geoSource = 'reused from caller';
  } else {
    // 只有在没有传入城市信息时才调用 GeoIP API
  
  // 读取配置化的API优先级
  const asyncConfig = getConfig();
  const apiPriority = asyncConfig.geoip.API_PRIORITY;
  const apiTimeout = asyncConfig.geoip.API_TIMEOUT_MS;
  
  // API调用函数映射表
  const apiHandlers = {
    'ipdata.co': async () => {
      if (!settings.IPDataAPIKey) return null;
      const response = await fetch(
        `https://api.ipdata.co/${clientIp}?api-key=${settings.IPDataAPIKey}`,
        { signal: AbortSignal.timeout(apiTimeout) }
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.country_name) return null;
      
      const countryEmoji = data.emoji_flag || getCountryEmoji(data.country_code) || '';
      return {
        info: `
*国家:* ${countryEmoji} \`${data.country_name || 'N/A'}\`
*城市:* \`${data.city || 'N/A'}\`
*ISP:* \`${data.asn?.name || 'N/A'}\`
*ASN:* \`${data.asn?.asn || 'N/A'}\``,
        source: 'ipdata.co'
      };
    },
    
    'ipwhois.io': async () => {
      const response = await fetch(
        `https://ipwhois.app/json/${clientIp}?lang=zh-CN`,
        { signal: AbortSignal.timeout(apiTimeout) }
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (data.success === false || !data.country) return null;
      
      const countryEmoji = getCountryEmoji(data.country_code) || '';
      return {
        info: `
*国家:* ${countryEmoji} \`${data.country || 'N/A'}\`
*城市:* \`${data.city || 'N/A'}\`
*ISP:* \`${data.isp || 'N/A'}\`
*ASN:* \`AS${data.asn || 'N/A'}\``,
        source: 'ipwhois.io'
      };
    },
    
    'ip-api.com': async () => {
      const response = await fetch(
        `http://ip-api.com/json/${clientIp}?lang=zh-CN`,
        { signal: AbortSignal.timeout(apiTimeout) }
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (data.status !== 'success') return null;
      
      const countryEmoji = getCountryEmoji(data.countryCode) || '';
      return {
        info: `
*国家:* ${countryEmoji} \`${data.country || 'N/A'}\`
*城市:* \`${data.city || 'N/A'}\`
*ISP:* \`${data.org || 'N/A'}\`
*ASN:* \`${data.as || 'N/A'}\``,
        source: 'ip-api.com'
      };
    },
    
    'ipgeolocation.io': async () => {
      if (!settings.IPGeoAPIKey) return null;
      const response = await fetch(
        `https://api.ipgeolocation.io/ipgeo?apiKey=${settings.IPGeoAPIKey}&ip=${clientIp}`,
        { signal: AbortSignal.timeout(apiTimeout) }
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.country_name) return null;
      
      const countryEmoji = data.country_emoji || '';
      const district = data.district || '';
      let info = `
*国家:* ${countryEmoji} \`${data.country_name || 'N/A'}\`
*城市:* \`${data.city || 'N/A'}\``;
      
      if (district) {
        info += `
*街道:* \`${district}\``;
      }
      
      const isp = data.organization || data.isp || 'N/A';
      const asn = data.asn || data.connection?.asn || data.as || 'N/A';
      info += `
*ISP:* \`${isp}\`
*ASN:* \`${asn}\``;
      
      return {
        info,
        source: 'ipgeolocation.io'
      };
    },
    
    'cloudflare': async () => {
      if (!request.cf) return null;
      const cf = request.cf;
      const countryEmoji = getCountryEmoji(cf.country) || '';
      return {
        info: `
*国家:* ${countryEmoji} \`${cf.country || 'N/A'}\`
*城市:* \`${cf.city || 'N/A'}\` ⚠️
*ISP:* \`${cf.asOrganization || 'N/A'}\`
*ASN:* \`AS${cf.asn || 'N/A'}\``,
        source: 'Cloudflare (城市可能不准)'
      };
    }
  };
  
  // 按配置的优先级依次尝试API
  for (const apiName of apiPriority) {
    if (locationInfo) break; // 已获取到信息，停止尝试
    
    const handler = apiHandlers[apiName];
    if (!handler) {
      console.warn(`[GeoIP] Unknown API: ${apiName}`);
      continue;
    }
    
    try {
      const result = await handler();
      if (result) {
        locationInfo = result.info;
        geoSource = result.source;
        console.log(`[GeoIP] Success: ${geoSource}`);
        break;
      }
    } catch (error) {
      console.log(`[GeoIP] ${apiName} failed:`, error.message);
      // 继续尝试下一个API
    }
  }
  
  // 如果所有API都失败，返回失败提示
  if (!locationInfo) {
    locationInfo = '\n*地理信息:* 获取失败';
    geoSource = 'failed';
  }
  } // 关闭 else 块
  
  // 构建完整消息
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const message = `${type}

*IP 地址:* \`${clientIp}\`${locationInfo}
*数据来源:* \`${geoSource}\`

${additionalData}

*时间:* \`${now} (UTC+8)\``;
  
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  const payload = { 
    chat_id: settings.ChatID, 
    text: message, 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

async function handleCronTrigger(env) {
    const storageAdapter = await getStorageAdapter(env);
    const originalSubs = await storageAdapter.get(KV_KEY_SUBS) || [];
    const allSubs = JSON.parse(JSON.stringify(originalSubs)); // 深拷贝以便比较
    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || defaultSettings;

    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm;
    let changesMade = false; // 修复: 声明changesMade变量

    for (const sub of allSubs) {
        if (sub.url.startsWith('http') && sub.enabled) {
            try {
                // --- 並行請求流量和節點內容 ---
                const trafficRequest = fetch(new Request(sub.url, { 
                    headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, 
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } 
                }));
                const nodeCountRequest = fetch(new Request(sub.url, { 
                    headers: { 'User-Agent': 'MiSub-Cron-Updater/1.0' }, 
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } 
                }));
                const [trafficResult, nodeCountResult] = await Promise.allSettled([
                    Promise.race([trafficRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))]),
                    Promise.race([nodeCountRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))])
                ]);   

                if (trafficResult.status === 'fulfilled' && trafficResult.value.ok) {
                    const userInfoHeader = trafficResult.value.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        sub.userInfo = info; // 更新流量資訊
                        await checkAndNotify(sub, settings, env); // 檢查並發送通知
                        changesMade = true;
                    }
                } else if (trafficResult.status === 'rejected') {
                     // 流量请求失败
                }

                if (nodeCountResult.status === 'fulfilled' && nodeCountResult.value.ok) {
                    const text = await nodeCountResult.value.text();
                    let decoded = '';
                    try { 
                        // 嘗試 Base64 解碼
                        decoded = atob(text.replace(/\s/g, '')); 
                    } catch { 
                        decoded = text; 
                    }
                    const matches = decoded.match(nodeRegex);
                    if (matches) {
                        sub.nodeCount = matches.length; // 更新節點數量
                        changesMade = true;
                    }
                } else if (nodeCountResult.status === 'rejected') {
                    // 节点数量请求失败
                }

            } catch(e) {
                // 请求处理出错
            }
        }
    }

    if (changesMade) {
        await storageAdapter.put(KV_KEY_SUBS, allSubs);
    }
    return new Response("Cron job completed successfully.", { status: 200 });
}

// --- 认证与API处理的核心函数 (无修改) ---
async function createSignedToken(key, data) {
    if (!key || !data) throw new Error("Key and data are required for signing.");
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const dataToSign = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataToSign);
    return `${data}.${Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
async function verifySignedToken(key, token) {
    if (!key || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data] = parts;
    const expectedToken = await createSignedToken(key, data);
    return token === expectedToken ? data : null;
}
async function authMiddleware(request, env) {
    if (!env.COOKIE_SECRET) return false;
    const cookie = request.headers.get('Cookie');
    const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
    if (!sessionCookie) return false;
    const token = sessionCookie.split('=')[1];
    const verifiedData = await verifySignedToken(env.COOKIE_SECRET, token);
    const sessionDurationMs = getSessionDurationMs(env);
    return verifiedData && (Date.now() - parseInt(verifiedData, 10) < sessionDurationMs);
}

// sub: 要检查的订阅对象
// settings: 全局设置
// env: Cloudflare 环境
async function checkAndNotify(sub, settings, env) {
    if (!sub.userInfo) return; // 没有流量信息，无法检查

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 1. 检查订阅到期
    if (sub.userInfo.expire) {
        const expiryDate = new Date(sub.userInfo.expire * 1000);
        const daysRemaining = Math.ceil((expiryDate - now) / ONE_DAY_MS);
        
        // 检查是否满足通知条件：剩余天数 <= 阈值
        if (daysRemaining <= (settings.NotifyThresholdDays || 7)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
                const message = `🗓️ *订阅临期提醒* 🗓️

*订阅名称:* \`${sub.name || '未命名'}\`
*状态:* \`${daysRemaining < 0 ? '已过期' : `仅剩 ${daysRemaining} 天到期`}\`
*到期日期:* \`${expiryDate.toLocaleDateString('zh-CN')}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedExpire = now; // 更新通知时间戳
                }
            }
        }
    }

    // 2. 检查流量使用
    const { upload, download, total } = sub.userInfo;
    if (total > 0) {
        const used = upload + download;
        const usagePercent = Math.round((used / total) * 100);

        // 检查是否满足通知条件：已用百分比 >= 阈值
        if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
            // 检查上次通知时间，防止24小时内重复通知
            if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
                const formatBytes = (bytes) => {
                    if (!+bytes) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
                };
                
                const message = `📈 *流量预警提醒* 📈

*订阅名称:* \`${sub.name || '未命名'}\`
*状态:* \`已使用 ${usagePercent}%\`
*详情:* \`${formatBytes(used)} / ${formatBytes(total)}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedTraffic = now; // 更新通知时间戳
                }
            }
        }
    }
}


// --- 主要 API 請求處理 ---
async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    // [新增] 数据存储迁移接口 (KV -> D1)
    if (path === '/migrate_to_d1') {
        if (!await authMiddleware(request, env)) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        try {
            if (!env.MISUB_DB) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'D1 数据库未配置，请检查 wrangler.toml 配置'
                }), { status: 400 });
            }

            const migrationResult = await DataMigrator.migrateKVToD1(env);

            if (migrationResult.errors.length > 0) {
                return new Response(JSON.stringify({
                    success: false,
                    message: '迁移过程中出现错误',
                    details: migrationResult.errors,
                    partialSuccess: migrationResult
                }), { status: 500 });
            }

            return new Response(JSON.stringify({
                success: true,
                message: '数据已成功迁移到 D1 数据库',
                details: migrationResult
            }), { status: 200 });

        } catch (error) {
            console.error('[API Error /migrate_to_d1]', error);
            return new Response(JSON.stringify({
                success: false,
                message: `迁移失败: ${error.message}`
            }), { status: 500 });
        }
    }

    // [新增] 安全的、可重复执行的迁移接口
    if (path === '/migrate') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
        try {
            const oldData = await env.MISUB_KV.get(OLD_KV_KEY, 'json');
            const newDataExists = await env.MISUB_KV.get(KV_KEY_SUBS) !== null;

            if (newDataExists) {
                return new Response(JSON.stringify({ success: true, message: '无需迁移，数据已是最新结构。' }), { status: 200 });
            }
            if (!oldData) {
                return new Response(JSON.stringify({ success: false, message: '未找到需要迁移的旧数据。' }), { status: 404 });
            }
            
            await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
            await env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
            await env.MISUB_KV.put(OLD_KV_KEY + '_migrated_on_' + new Date().toISOString(), JSON.stringify(oldData));
            await env.MISUB_KV.delete(OLD_KV_KEY);

            return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }), { status: 200 });
        } catch (e) {
            console.error('[API Error /migrate]', e);
            return new Response(JSON.stringify({ success: false, message: `迁移失败: ${e.message}` }), { status: 500 });
        }
    }

    if (path === '/login') {
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        try {
            const { password } = await request.json();
            if (password === env.ADMIN_PASSWORD) {
                const token = await createSignedToken(env.COOKIE_SECRET, String(Date.now()));
                const sessionDurationMs = getSessionDurationMs(env);
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionDurationMs / 1000}`);
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
        } catch (e) {
            console.error('[API Error /login]', e);
            return new Response(JSON.stringify({ error: '请求体解析失败' }), { status: 400 });
        }
    }
    if (!await authMiddleware(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    // ==================== 用户管理 API ====================
    
    // GET /api/users - 用户列表（支持过滤、搜索、分页）
    if (path === '/users' && request.method === 'GET') {
        try {
            const url = new URL(request.url);
            const profileIdParam = url.searchParams.get('profileId');
            const status = url.searchParams.get('status');
            const search = url.searchParams.get('search');
            const page = parseInt(url.searchParams.get('page')) || 0;
            const pageSize = parseInt(url.searchParams.get('pageSize')) || 20;
            
            // 【修复】先加载 profiles（后面也需要用）
            const storageAdapter = await getStorageAdapter(env);
            const profiles = await storageAdapter.get(KV_KEY_PROFILES) || [];
            
            // 如果传入了 profileId，先找到对应的 profile，获取 id 和 customId
            let profileIdToMatch = null;
            let profileCustomIdToMatch = null;
            if (profileIdParam) {
                const targetProfile = profiles.find(p => 
                    p.id === profileIdParam || (p.customId && p.customId === profileIdParam)
                );
                if (targetProfile) {
                    profileIdToMatch = targetProfile.id;
                    profileCustomIdToMatch = targetProfile.customId;
                }
            }
            
            // 构建查询条件
            let query = 'SELECT token, data, created_at, updated_at FROM users';
            const conditions = [];
            const params = [];
            
            if (profileIdToMatch) {
                // 同时匹配 id 和 customId（兼容旧数据）
                if (profileCustomIdToMatch) {
                    conditions.push("(json_extract(data, '$.profileId') = ? OR json_extract(data, '$.profileId') = ?)");
                    params.push(profileIdToMatch, profileCustomIdToMatch);
                } else {
                    conditions.push("json_extract(data, '$.profileId') = ?");
                    params.push(profileIdToMatch);
                }
            }
            // 状态筛选：pending 和 activated 可以直接 SQL 查询
            // expired 和 suspended 需要在内存中过滤
            if (status && (status === 'pending' || status === 'activated')) {
                conditions.push("json_extract(data, '$.status') = ?");
                params.push(status);
            }
            if (search) {
                conditions.push("(token LIKE ? OR json_extract(data, '$.userToken') LIKE ? OR json_extract(data, '$.remark') LIKE ?)");
                params.push(`%${search}%`, `%${search}%`, `%${search}%`);
            }
            
            // 记录 WHERE 子句的参数数量（用于 count 查询）
            const whereParamsCount = params.length;
            
            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }
            
            query += ' ORDER BY created_at DESC';
            
            // 对于 expired 和 suspended 状态，不使用 LIMIT，后面在内存中过滤
            // 对于其他筛选，使用 LIMIT 提高性能
            if (!status || status === 'pending' || status === 'activated') {
                query += ' LIMIT ? OFFSET ?';
                params.push(pageSize, page * pageSize);
            }
            
            // 查询用户
            const result = await env.MISUB_DB.prepare(query).bind(...params).all();
            
            // profiles 已在前面加载，这里直接使用
            // 同时使用 id 和 customId 建立映射，以兼容旧数据
            const profileMap = new Map();
            profiles.forEach(p => {
                profileMap.set(p.id, p);
                if (p.customId) {
                    profileMap.set(p.customId, p);
                }
            });
            
            // 组装数据
            const asyncConfig = getConfig();
            const now = Date.now();
            
            // 获取全局的 profileToken（订阅组分享Token）
            const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
            const globalProfileToken = settings.profileToken;
            
            let users = result.results.map(row => {
                const userData = JSON.parse(row.data);
                const profile = profileMap.get(userData.profileId);
                const effectiveAntiShareConfig = resolveAntiShareConfig(profile, userData, asyncConfig);
                
                // 计算唯一城市数量（从所有设备的城市列表中收集，与详情页保持一致）
                const uniqueCities = new Set();
                Object.values(userData.devices || {}).forEach(device => {
                    if (device && device.cities) {
                        Object.keys(device.cities).forEach(cityKey => {
                            uniqueCities.add(cityKey);
                        });
                    }
                });
                
                // 【修复】封禁状态判断：suspend 对象没有 status 字段，只需检查 until
                const isSuspended = userData.suspend?.until && userData.suspend.until > now;
                
                // 【调试】检查 expiresAt 的值和类型
                let isExpired = false;
                if (userData.expiresAt) {
                    const expiresAtTime = typeof userData.expiresAt === 'string' 
                        ? new Date(userData.expiresAt).getTime() 
                        : userData.expiresAt;
                    isExpired = expiresAtTime < now;
                    console.log(`[DEBUG] Token: ${row.token}, expiresAt: ${userData.expiresAt}, expiresAtTime: ${expiresAtTime}, now: ${now}, isExpired: ${isExpired}`);
                }
                
                // 生成订阅链接
                // 使用全局的 profileToken（订阅组分享Token），profileId 可以是 customId 或真实 id
                const profileIdForUrl = profile?.customId || userData.profileId;
                const subscriptionUrl = globalProfileToken 
                    ? `${new URL(request.url).origin}/${globalProfileToken}/${profileIdForUrl}/${row.token}`
                    : null;
                
                return {
                    token: row.token,
                    profileId: userData.profileId,
                    profileName: profile?.name || 'Unknown',
                    customId: profile?.customId || '',
                    remark: userData.remark || '',
                    status: userData.status,
                    deviceCount: Object.keys(userData.devices || {}).length,
                    deviceLimit: effectiveAntiShareConfig.MAX_DEVICES,
                    cityCount: uniqueCities.size,  // 使用从 device.cities 收集的唯一城市数
                    cityLimit: effectiveAntiShareConfig.MAX_CITIES,
                    activatedAt: userData.activatedAt,
                    expiresAt: userData.expiresAt,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    isSuspended,
                    isExpired,
                    suspendReason: userData.suspend?.reason || null,
                    subscriptionUrl
                };
            });
            
            // 【内存过滤】expired 和 suspended 状态
            if (status === 'expired') {
                users = users.filter(user => user.isExpired);
            } else if (status === 'suspended') {
                users = users.filter(user => user.isSuspended);
            }
            
            // 分页处理（如果之前没有在 SQL 中分页）
            const totalBeforePaging = users.length;
            if (status === 'expired' || status === 'suspended') {
                const startIndex = page * pageSize;
                users = users.slice(startIndex, startIndex + pageSize);
            }
            
            // 获取总数（用于分页）
            let total;
            if (status === 'expired' || status === 'suspended') {
                // 对于 expired 和 suspended，使用过滤后的总数
                total = totalBeforePaging;
            } else {
                // 对于其他状态，从数据库查询总数
                let countQuery = 'SELECT COUNT(*) as total FROM users';
                if (conditions.length > 0) {
                    countQuery += ' WHERE ' + conditions.join(' AND ');
                }
                // 只使用 WHERE 子句的参数（不包括 LIMIT 和 OFFSET）
                const countParams = params.slice(0, whereParamsCount);
                const countResult = await env.MISUB_DB.prepare(countQuery)
                    .bind(...countParams)
                    .first();
                total = countResult.total;
            }
            
            return new Response(JSON.stringify({
                success: true,
                data: users,
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: Math.ceil(total / pageSize)
                }
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users GET]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // GET /api/users/:token - 用户详情
    if (path.startsWith('/users/') && request.method === 'GET') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            
            // 【修复】检查封禁是否过期（suspend 对象没有 status 字段）
            const now = Date.now();
            let activeSuspend = null;
            if (userData.suspend?.until && userData.suspend.until > now) {
                // 封禁仍然有效
                activeSuspend = userData.suspend;
            }
            // 如果已过期或不存在，activeSuspend 保持 null
            
            // 加载 profile 信息
            const profiles = await storageAdapter.get(KV_KEY_PROFILES) || [];
            const profile = profiles.find(p => p.id === userData.profileId || p.customId === userData.profileId);
            
            // 组装完整的用户信息
            const userDetail = {
                token: userData.userToken,
                profileId: userData.profileId,
                profileName: profile?.name || 'Unknown',
                customId: profile?.customId || '',
                status: userData.status,
                activatedAt: userData.activatedAt,
                expiresAt: userData.expiresAt,
                
                // 用户备注
                remark: userData.remark || '',
                remarkHistory: userData.remarkHistory || [],
                
                // 设备信息
                devices: Object.entries(userData.devices || {}).map(([id, device]) => ({
                    id,
                    name: device.name || device.userAgent || 'Unknown',
                    lastSeen: device.lastSeen,
                    activatedAt: device.firstSeen
                })),
                
                // 城市信息（从所有设备的城市列表中收集）
                cities: (() => {
                    const citiesMap = new Map();
                    Object.values(userData.devices || {}).forEach(device => {
                        Object.entries(device.cities || {}).forEach(([cityKey, cityData]) => {
                            if (!citiesMap.has(cityKey)) {
                                citiesMap.set(cityKey, {
                                    id: cityKey,
                                    name: cityData.city || 'Unknown',
                                    ip: cityData.ip || 'Unknown',  // 返回 IP 地址
                                    firstSeen: cityData.firstSeen,
                                    lastSeen: cityData.lastSeen
                                });
                            } else {
                                // 如果多个设备访问同一城市，更新最后访问时间
                                const existing = citiesMap.get(cityKey);
                                if (cityData.lastSeen > existing.lastSeen) {
                                    existing.lastSeen = cityData.lastSeen;
                                }
                            }
                        });
                    });
                    return Array.from(citiesMap.values());
                })(),
                
                // 统计信息
                stats: {
                    totalRequests: userData.stats?.totalRequests || 0,
                    lastRequest: userData.stats?.lastRequest,
                    dailyCount: userData.stats?.dailyCount || 0,
                    failedAttempts: userData.stats?.failedAttempts || 0,
                    lastFailedAttempt: userData.stats?.lastFailedAttempt,
                    rateLimitAttempts: userData.stats?.rateLimitAttempts || 0
                },
                
                // 封禁信息（只返回有效的封禁）
                suspend: activeSuspend,
                
                // 限流信息
                rateLimit: userData.rateLimit || null,
                
                // 时间戳
                createdAt: userData.createdAt
            };
            
            return new Response(JSON.stringify({
                success: true,
                data: userDetail
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/:token GET]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // POST /api/users/:token/unsuspend - 解封用户
    if (path.match(/^\/users\/[^\/]+\/unsuspend$/) && request.method === 'POST') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            
            // 解除封禁
            userData.suspend = null;
            userData.stats = userData.stats || {};
            userData.stats.failedAttempts = 0;
            
            // 保存更新
            await storageAdapter.put(`user:${token}`, userData);
            
            return new Response(JSON.stringify({
                success: true,
                message: '用户已解封'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/:token/unsuspend POST]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }

    // POST /api/users/:token/reset-daily - 重置用户今日访问次数
    if (path.match(/^\/users\/[^\/]+\/reset-daily$/) && request.method === 'POST') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }

            let body = {};
            try {
                body = await request.json();
            } catch {
                body = {};
            }

            const newDailyCount = body.value === undefined ? 0 : body.value;
            if (typeof newDailyCount !== 'number' || !Number.isFinite(newDailyCount) || newDailyCount < 0 || !Number.isInteger(newDailyCount)) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'value 必须是非负整数'
                }), { status: 400 });
            }

            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);

            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }

            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            userData.stats = userData.stats || {};

            const now = new Date();
            const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
            const today = shanghaiNow.toISOString().split('T')[0];

            const oldDailyCount = userData.stats.dailyCount || 0;
            userData.stats.dailyCount = newDailyCount;
            userData.stats.dailyDate = today;
            userData.stats.failedAttempts = 0;
            userData.stats.rateLimitAttempts = 0;

            await storageAdapter.put(`user:${token}`, userData);

            console.log('[Admin Action] reset-daily', {
                token,
                oldDailyCount,
                newDailyCount,
                today
            });

            return new Response(JSON.stringify({
                success: true,
                message: '今日访问次数已重置',
                data: {
                    dailyCount: userData.stats.dailyCount,
                    dailyDate: userData.stats.dailyDate
                }
            }), {
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            console.error('[API Error /users/:token/reset-daily POST]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // DELETE /api/users/:token - 删除用户
    if (path.match(/^\/users\/[^\/]+$/) && request.method === 'DELETE') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            // 删除用户
            await storageAdapter.delete(`user:${token}`);
            
            return new Response(JSON.stringify({
                success: true,
                message: '用户已删除'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/:token DELETE]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // POST /api/users/batch-delete - 批量删除用户
    if (path === '/users/batch-delete' && request.method === 'POST') {
        try {
            const { tokens } = await request.json();
            
            if (!Array.isArray(tokens) || tokens.length === 0) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '请提供有效的 token 列表'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const results = {
                success: 0,
                failed: 0,
                errors: []
            };
            
            // 批量删除
            for (const token of tokens) {
                try {
                    const userDataRaw = await storageAdapter.get(`user:${token}`);
                    if (userDataRaw) {
                        await storageAdapter.delete(`user:${token}`);
                        results.success++;
                    } else {
                        results.failed++;
                        results.errors.push(`${token}: 用户不存在`);
                    }
                } catch (err) {
                    results.failed++;
                    results.errors.push(`${token}: ${err.message}`);
                }
            }
            
            return new Response(JSON.stringify({
                success: true,
                message: `成功删除 ${results.success} 个用户${results.failed > 0 ? `，失败 ${results.failed} 个` : ''}`,
                data: results
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/batch-delete POST]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // DELETE /api/users/:token/devices/:deviceId - 删除单个设备
    if (path.match(/^\/users\/[^\/]+\/devices\/[^\/]+$/) && request.method === 'DELETE') {
        try {
            const parts = path.split('/');
            const token = parts[2];
            const deviceId = parts[4];
            if (!token || !deviceId) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token and deviceId are required'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            if (!userData.devices || !userData.devices[deviceId]) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '设备不存在'
                }), { status: 404 });
            }
            
            delete userData.devices[deviceId];
            await storageAdapter.put(`user:${token}`, userData);
            
            return new Response(JSON.stringify({
                success: true,
                message: '设备已解绑'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('[API Error /users/:token/devices/:deviceId DELETE]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // PATCH /api/users/:token - 修改用户信息
    if (path.match(/^\/users\/[^\/]+$/) && request.method === 'PATCH') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }
            
            const updates = await request.json();
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            
            // 更新允许修改的字段
            if (updates.expiresAt !== undefined) {
                userData.expiresAt = updates.expiresAt;
            }
            if (updates.profileId !== undefined) {
                userData.profileId = updates.profileId;
            }
            if (updates.status !== undefined) {
                userData.status = updates.status;
            }
            
            // 【新增】处理备注更新
            if (updates.remark !== undefined) {
                // 验证备注长度（最多50字符）
                if (updates.remark && updates.remark.length > 50) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: '备注长度不能超过50字符'
                    }), { status: 400 });
                }
                
                // 如果备注有变化，记录到历史
                if (updates.remark !== (userData.remark || '')) {
                    if (!userData.remarkHistory) {
                        userData.remarkHistory = [];
                    }
                    
                    // 保存旧备注到历史（最多保留10条）
                    userData.remarkHistory.unshift({
                        content: userData.remark || '',
                        updatedAt: new Date().toISOString()
                    });
                    
                    // 只保留最近 10 条历史
                    userData.remarkHistory = userData.remarkHistory.slice(0, 10);
                }
                
                userData.remark = updates.remark;
            }
            
            // 保存更新
            await storageAdapter.put(`user:${token}`, userData);
            
            return new Response(JSON.stringify({
                success: true,
                message: '用户信息已更新'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/:token PATCH]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // DELETE /api/users/:token - 删除用户
    if (path.match(/^\/users\/[^\/]+$/) && request.method === 'DELETE') {
        try {
            const token = path.split('/')[2];
            if (!token) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Token is required'
                }), { status: 400 });
            }
            
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${token}`);
            
            if (!userDataRaw) {
                return new Response(JSON.stringify({
                    success: false,
                    error: '用户不存在'
                }), { status: 404 });
            }
            
            // 删除用户
            await storageAdapter.delete(`user:${token}`);
            
            return new Response(JSON.stringify({
                success: true,
                message: '用户已删除'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('[API Error /users/:token DELETE]', error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message
            }), { status: 500 });
        }
    }
    
    // ==================== 原有 API ====================

    switch (path) {
        case '/logout': {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
            return new Response(JSON.stringify({ success: true }), { headers });
        }
        
        case '/data': {
            try {
                const storageAdapter = await getStorageAdapter(env);
                const [misubs, profiles, settings] = await Promise.all([
                    storageAdapter.get(KV_KEY_SUBS).then(res => res || []),
                    storageAdapter.get(KV_KEY_PROFILES).then(res => res || []),
                    storageAdapter.get(KV_KEY_SETTINGS).then(res => res || {})
                ]);
                const config = {
                    FileName: settings.FileName || 'SUBHUB',
                    mytoken: settings.mytoken || 'auto',
                    profileToken: settings.profileToken || 'profiles'
                };
                return new Response(JSON.stringify({ misubs, profiles, config }), { headers: { 'Content-Type': 'application/json' } });
            } catch(e) {
                console.error('[API Error /data]', 'Failed to read from storage:', e);
                return new Response(JSON.stringify({ error: '读取初始数据失败' }), { status: 500 });
            }
        }

        case '/misubs': {
            try {
                // 步骤1: 解析请求体
                let requestData;
                try {
                    requestData = await request.json();
                } catch (parseError) {
                    console.error('[API Error /misubs] JSON解析失败:', parseError);
                    return new Response(JSON.stringify({
                        success: false,
                        message: '请求数据格式错误，请检查数据格式'
                    }), { status: 400 });
                }

                const { misubs, profiles } = requestData;

                // 步骤2: 验证必需字段
                if (typeof misubs === 'undefined' || typeof profiles === 'undefined') {
                    return new Response(JSON.stringify({
                        success: false,
                        message: '请求体中缺少 misubs 或 profiles 字段'
                    }), { status: 400 });
                }

                // 步骤3: 验证数据类型
                if (!Array.isArray(misubs) || !Array.isArray(profiles)) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: 'misubs 和 profiles 必须是数组格式'
                    }), { status: 400 });
                }

                // 步骤4: 获取设置（带错误处理）
                let settings;
                try {
                    const storageAdapter = await getStorageAdapter(env);
                    settings = await storageAdapter.get(KV_KEY_SETTINGS) || defaultSettings;
                } catch (settingsError) {
                    settings = defaultSettings; // 使用默认设置继续
                }

                // 步骤5: 处理通知（非阻塞，错误不影响保存）
                try {
                    const notificationPromises = misubs
                        .filter(sub => sub && sub.url && sub.url.startsWith('http'))
                        .map(sub => checkAndNotify(sub, settings, env).catch(notifyError => {
                            // 通知失败不影响保存流程
                        }));

                    // 并行处理通知，但不等待完成
                    Promise.all(notificationPromises).catch(e => {
                        // 部分通知处理失败
                    });
                } catch (notificationError) {
                    // 通知系统错误，继续保存流程
                }

                // {{ AURA-X: Modify - 使用存储适配器保存数据. Approval: 寸止(ID:1735459200). }}
                // 步骤6: 保存数据到存储（使用存储适配器）
                try {
                    const storageAdapter = await getStorageAdapter(env);
                    await Promise.all([
                        storageAdapter.put(KV_KEY_SUBS, misubs),
                        storageAdapter.put(KV_KEY_PROFILES, profiles)
                    ]);
                } catch (storageError) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: `数据保存失败: ${storageError.message || '存储服务暂时不可用，请稍后重试'}`
                    }), { status: 500 });
                }

                return new Response(JSON.stringify({
                    success: true,
                    message: '订阅源及订阅组已保存'
                }));

            } catch (e) {
                return new Response(JSON.stringify({
                    success: false,
                    message: `保存失败: ${e.message || '服务器内部错误，请稍后重试'}`
                }), { status: 500 });
            }
        }

            case '/node_count': {
                if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
                const { url: subUrl } = await request.json();
                if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//.test(subUrl)) {
                    return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
                }
                
                const result = { count: 0, userInfo: null };

                try {
                    const fetchOptions = {
                        headers: { 'User-Agent': 'MiSub-Node-Counter/2.0' },
                        redirect: "follow",
                        cf: { insecureSkipVerify: true }
                    };
                    const trafficFetchOptions = {
                        headers: { 'User-Agent': 'Clash for Windows/0.20.39' },
                        redirect: "follow",
                        cf: { insecureSkipVerify: true }
                    };

                    const trafficRequest = fetch(new Request(subUrl, trafficFetchOptions));
                    const nodeCountRequest = fetch(new Request(subUrl, fetchOptions));

                    // --- [核心修正] 使用 Promise.allSettled 替换 Promise.all ---
                    const responses = await Promise.allSettled([trafficRequest, nodeCountRequest]);

                    // 1. 处理流量请求的结果
                    if (responses[0].status === 'fulfilled' && responses[0].value.ok) {
                        const trafficResponse = responses[0].value;
                        const userInfoHeader = trafficResponse.headers.get('subscription-userinfo');
                        if (userInfoHeader) {
                            const info = {};
                            userInfoHeader.split(';').forEach(part => {
                                const [key, value] = part.trim().split('=');
                                if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                            });
                            result.userInfo = info;
                        }
                    } else if (responses[0].status === 'rejected') {
                        // 流量请求失败
                    }

                    // 2. 处理节点数请求的结果
                    if (responses[1].status === 'fulfilled' && responses[1].value.ok) {
                        const nodeCountResponse = responses[1].value;
                        const text = await nodeCountResponse.text();
                        let decoded = '';
                        try { decoded = atob(text.replace(/\s/g, '')); } catch { decoded = text; }
                        const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm);
                        if (lineMatches) {
                            result.count = lineMatches.length;
                        }
                    } else if (responses[1].status === 'rejected') {
                        // 节点数请求失败
                    }
                    
                    // {{ AURA-X: Modify - 使用存储适配器优化节点计数更新. Approval: 寸止(ID:1735459200). }}
                    // 只有在至少获取到一个有效信息时，才更新数据库
                    if (result.userInfo || result.count > 0) {
                        const storageAdapter = await getStorageAdapter(env);
                        const originalSubs = await storageAdapter.get(KV_KEY_SUBS) || [];
                        const allSubs = JSON.parse(JSON.stringify(originalSubs)); // 深拷贝
                        const subToUpdate = allSubs.find(s => s.url === subUrl);

                        if (subToUpdate) {
                            subToUpdate.nodeCount = result.count;
                            subToUpdate.userInfo = result.userInfo;

                            await storageAdapter.put(KV_KEY_SUBS, allSubs);
                        }
                    }
                    
                } catch (e) {
                    // 节点计数处理错误
                }
                
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
            }

        case '/fetch_external_url': { // New case
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            const { url: externalUrl } = await request.json();
            if (!externalUrl || typeof externalUrl !== 'string' || !/^https?:\/\//.test(externalUrl)) {
                return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
            }

            try {
                const response = await fetch(new Request(externalUrl, {
                    headers: { 'User-Agent': 'MiSub-Proxy/1.0' }, // Identify as proxy
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } // Allow insecure SSL for flexibility
                }));

                if (!response.ok) {
                    return new Response(JSON.stringify({ error: `Failed to fetch external URL: ${response.status} ${response.statusText}` }), { status: response.status });
                }

                const content = await response.text();
                return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

            } catch (e) {
                return new Response(JSON.stringify({ error: `Failed to fetch external URL: ${e.message}` }), { status: 500 });
            }
        }

        // {{ AURA-X: Add - 批量节点更新API端点. Approval: 寸止(ID:1735459200). }}
        case '/batch_update_nodes': {
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            if (!await authMiddleware(request, env)) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
            }

            try {
                const { subscriptionIds } = await request.json();
                if (!Array.isArray(subscriptionIds)) {
                    return new Response(JSON.stringify({ error: 'subscriptionIds must be an array' }), { status: 400 });
                }

                const storageAdapter = await getStorageAdapter(env);
                const allSubs = await storageAdapter.get(KV_KEY_SUBS) || [];
                const subsToUpdate = allSubs.filter(sub => subscriptionIds.includes(sub.id) && sub.url.startsWith('http'));

                // 并行更新所有订阅的节点信息
                const updatePromises = subsToUpdate.map(async (sub) => {
                    try {
                        const fetchOptions = {
                            headers: { 'User-Agent': 'MiSub-Batch-Updater/1.0' },
                            redirect: "follow",
                            cf: { insecureSkipVerify: true }
                        };

                        const response = await Promise.race([
                            fetch(sub.url, fetchOptions),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                        ]);

                        if (response.ok) {
                            // 更新流量信息
                            const userInfoHeader = response.headers.get('subscription-userinfo');
                            if (userInfoHeader) {
                                const info = {};
                                userInfoHeader.split(';').forEach(part => {
                                    const [key, value] = part.trim().split('=');
                                    if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                                });
                                sub.userInfo = info;
                            }

                            // 更新节点数量
                            const text = await response.text();
                            let decoded = '';
                            try {
                                decoded = atob(text.replace(/\s/g, ''));
                            } catch {
                                decoded = text;
                            }
                            const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm;
                            const matches = decoded.match(nodeRegex);
                            sub.nodeCount = matches ? matches.length : 0;

                            return { id: sub.id, success: true, nodeCount: sub.nodeCount };
                        } else {
                            return { id: sub.id, success: false, error: `HTTP ${response.status}` };
                        }
                    } catch (error) {
                        return { id: sub.id, success: false, error: error.message };
                    }
                });

                const results = await Promise.allSettled(updatePromises);
                const updateResults = results.map(result =>
                    result.status === 'fulfilled' ? result.value : { success: false, error: 'Promise rejected' }
                );

                // 使用存储适配器保存更新后的数据
                await storageAdapter.put(KV_KEY_SUBS, allSubs);

                return new Response(JSON.stringify({
                    success: true,
                    message: '批量更新完成',
                    results: updateResults
                }), { headers: { 'Content-Type': 'application/json' } });

            } catch (error) {
                return new Response(JSON.stringify({
                    success: false,
                    message: `批量更新失败: ${error.message}`
                }), { status: 500 });
            }
        }

        case '/debug_subscription': {
            if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
            
            try {
                const { url: debugUrl, userAgent } = await request.json();
                if (!debugUrl || typeof debugUrl !== 'string' || !/^https?:\/\//.test(debugUrl)) {
                    return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
                }
                
                const result = {
                    url: debugUrl,
                    userAgent: userAgent || 'MiSub-Debug/1.0',
                    success: false,
                    rawContent: '',
                    processedContent: '',
                    validNodes: [],
                    ssNodes: [],
                    error: null
                };
                
                try {
                    const response = await fetch(new Request(debugUrl, {
                        headers: { 'User-Agent': result.userAgent },
                        redirect: "follow",
                        cf: { insecureSkipVerify: true }
                    }));
                    
                    if (!response.ok) {
                        result.error = `HTTP ${response.status}: ${response.statusText}`;
                        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
                    }
                    
                    const text = await response.text();
                    result.rawContent = text.substring(0, 2000); // 限制原始内容长度
                    
                    // 处理Base64解码
                    let processedText = text;
                    try {
                        const cleanedText = text.replace(/\s/g, '');
                        if (isValidBase64(cleanedText)) {
                            const binaryString = atob(cleanedText);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
                            processedText = new TextDecoder('utf-8').decode(bytes);
                        }
                    } catch (e) {
                        // Base64解码失败，使用原始内容
                    }
                    
                    result.processedContent = processedText.substring(0, 2000); // 限制处理后内容长度
                    
                    // 提取所有有效节点
                    const allNodes = processedText.replace(/\r\n/g, '\n').split('\n')
                        .map(line => line.trim())
                        .filter(line => /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//.test(line));
                    
                    result.validNodes = allNodes.slice(0, 20); // 限制显示节点数量
                    
                    // 特别提取SS节点进行分析
                    result.ssNodes = allNodes.filter(line => line.startsWith('ss://')).map(line => {
                        try {
                            const hashIndex = line.indexOf('#');
                            let baseLink = hashIndex !== -1 ? line.substring(0, hashIndex) : line;
                            let fragment = hashIndex !== -1 ? line.substring(hashIndex) : '';
                            
                            const protocolEnd = baseLink.indexOf('://');
                            const atIndex = baseLink.indexOf('@');
                            let analysis = {
                                original: line,
                                hasUrlEncoding: false,
                                fixed: line,
                                base64Part: '',
                                credentials: ''
                            };
                            
                            if (protocolEnd !== -1 && atIndex !== -1) {
                                const base64Part = baseLink.substring(protocolEnd + 3, atIndex);
                                analysis.base64Part = base64Part;
                                
                                if (base64Part.includes('%')) {
                                    analysis.hasUrlEncoding = true;
                                    const decodedBase64 = decodeURIComponent(base64Part);
                                    analysis.fixed = 'ss://' + decodedBase64 + baseLink.substring(atIndex) + fragment;
                                    
                                    try {
                                        analysis.credentials = atob(decodedBase64);
                                    } catch (e) {
                                        analysis.credentials = 'Base64解码失败: ' + e.message;
                                    }
                                } else {
                                    try {
                                        analysis.credentials = atob(base64Part);
                                    } catch (e) {
                                        analysis.credentials = 'Base64解码失败: ' + e.message;
                                    }
                                }
                            }
                            
                            return analysis;
                        } catch (e) {
                            return {
                                original: line,
                                error: e.message
                            };
                        }
                    }).slice(0, 10); // 限制SS节点分析数量
                    
                    result.success = true;
                    result.totalNodes = allNodes.length;
                    result.ssNodesCount = allNodes.filter(line => line.startsWith('ss://')).length;
                    
                } catch (e) {
                    result.error = e.message;
                }
                
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
                
            } catch (e) {
                return new Response(JSON.stringify({ error: `调试失败: ${e.message}` }), { status: 500 });
            }
        }

        case '/batch-generate': {
            if (request.method === 'POST') {
                // 授权检查
                if (!await authMiddleware(request, env)) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
                        status: 401, 
                        headers: { 'Content-Type': 'application/json' } 
                    });
                }
                
                try {
                    const { profileId, count, duration, remark } = await request.json();
                    const config = getConfig();
                    
                    // 参数验证
                    if (!profileId || !count || !duration) {
                        return new Response(JSON.stringify({ 
                            success: false, 
                            error: '缺少必需参数：profileId, count, duration' 
                        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }

                    // 备注长度校验（与用户备注保持一致，最多50个字符）
                    if (remark && typeof remark === 'string' && remark.length > 50) {
                        return new Response(JSON.stringify({
                            success: false,
                            error: '备注长度不能超过50个字符'
                        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                    
                    if (count < config.batchGenerate.MIN_TOKENS_PER_BATCH || count > config.batchGenerate.MAX_TOKENS_PER_BATCH) {
                        return new Response(JSON.stringify({ 
                            success: false, 
                            error: `生成数量必须在 ${config.batchGenerate.MIN_TOKENS_PER_BATCH}-${config.batchGenerate.MAX_TOKENS_PER_BATCH} 之间` 
                        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                    
                    // 允许小数有效期（支持测试：1分钟 = 1/1440 ≈ 0.000694）
                    if (duration <= 0 || duration > config.batchGenerate.MAX_DURATION_DAYS) {
                        return new Response(JSON.stringify({ 
                            success: false, 
                            error: `有效期必须大于0且不超过 ${config.batchGenerate.MAX_DURATION_DAYS} 天` 
                        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                    
                    // 获取设置（用于构建URL）
                    const storageAdapter = await getStorageAdapter(env);
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const mergedConfig = { ...defaultSettings, ...settings };
                    
                    // 验证订阅组是否存在
                    const allProfiles = await storageAdapter.get(KV_KEY_PROFILES) || [];
                    const profile = allProfiles.find(p => 
                        (p.customId && p.customId === profileId) || p.id === profileId
                    );
                    
                    if (!profile) {
                        return new Response(JSON.stringify({ 
                            success: false, 
                            error: '订阅组不存在' 
                        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                    }
                    
                    // 批量生成Token
                    const tokens = [];
                    const durationMs = duration * 24 * 60 * 60 * 1000;
                    const createdAt = Date.now();
                    
                    for (let i = 0; i < count; i++) {
                        const userToken = await generateUniqueUserToken(env, config.batchGenerate.TOKEN_LENGTH);
                        
                        // 创建用户数据
                        const userData = {
                            userToken,
                            profileId: profile.id,  // 使用真正的 profile.id，而不是传入的 profileId（可能是 customId）
                            status: 'pending',
                            createdAt,
                            activatedAt: null,
                            expiresAt: null,
                            duration: durationMs,
                            devices: {},
                            stats: {
                                totalRequests: 0,
                                lastRequest: null,
                                dailyCount: 0,
                                dailyDate: null,
                                failedAttempts: 0,        // 失败尝试次数（如新设备新城市）
                                rateLimitAttempts: 0      // 达到上限后的尝试次数
                            }
                        };

                        if (remark && typeof remark === 'string') {
                            userData.remark = remark;
                        }
                        
                        // 存储到KV
                        await storageAdapter.put(`user:${userToken}`, userData);
                        
                        // 构建URL（三段式）
                        const hostname = new URL(request.url).host;
                        const url = `https://${hostname}/${mergedConfig.profileToken}/${profileId}/${userToken}`;
                        
                        tokens.push({
                            token: userToken,
                            url,
                            status: 'pending',
                            createdAt
                        });
                    }
                    
                    // 发送Telegram通知
                    if (mergedConfig.BotToken && mergedConfig.ChatID) {
                        const message = `🎫 *批量生成订阅链接*\n\n*订阅组:* \`${profile.name}\`\n*数量:* ${count}\n*有效期:* ${duration}天\n*时间:* ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
                        await sendTgNotification(mergedConfig, message);
                    }
                    
                    return new Response(JSON.stringify({
                        success: true,
                        count: tokens.length,
                        tokens,
                        profileName: profile.name
                    }), { headers: { 'Content-Type': 'application/json' } });
                    
                } catch (error) {
                    console.error('[API Error /batch-generate]', error);
                    return new Response(JSON.stringify({ 
                        success: false, 
                        error: `批量生成失败: ${error.message}` 
                    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                }
            }
            return new Response('Method Not Allowed', { status: 405 });
        }

        case '/settings': {
            if (request.method === 'GET') {
                try {
                    const storageAdapter = await getStorageAdapter(env);
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
                } catch (e) {
                    return new Response(JSON.stringify({ error: '读取设置失败' }), { status: 500 });
                }
            }
            if (request.method === 'POST') {
                try {
                    const newSettings = await request.json();
                    const storageAdapter = await getStorageAdapter(env);
                    const oldSettings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const finalSettings = { ...oldSettings, ...newSettings };

                    // 使用存储适配器保存设置
                    await storageAdapter.put(KV_KEY_SETTINGS, finalSettings);

                    const message = `⚙️ *MiSub 设置更新* ⚙️\n\n您的 MiSub 应用设置已成功更新。`;
                    await sendTgNotification(finalSettings, message);

                    return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
                } catch (e) {
                    return new Response(JSON.stringify({ error: '保存设置失败' }), { status: 500 });
                }
            }
            return new Response('Method Not Allowed', { status: 405 });
        }
    }
    
    return new Response('API route not found', { status: 404 });
}
// --- 名称前缀辅助函数 (无修改) ---
function prependNodeName(link, prefix) {
  if (!prefix) return link;
  const appendToFragment = (baseLink, namePrefix) => {
    const hashIndex = baseLink.lastIndexOf('#');
    const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
    const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
    if (originalName.startsWith(namePrefix)) {
        return baseLink;
    }
    const newName = originalName ? `${namePrefix} - ${originalName}` : namePrefix;
    return `${base}#${encodeURIComponent(newName)}`;
  }
  if (link.startsWith('vmess://')) {
    try {
      const base64Part = link.substring('vmess://'.length);
      const binaryString = atob(base64Part);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
      }
      const jsonString = new TextDecoder('utf-8').decode(bytes);
      const nodeConfig = JSON.parse(jsonString);
      const originalPs = nodeConfig.ps || '';
      if (!originalPs.startsWith(prefix)) {
        nodeConfig.ps = originalPs ? `${prefix} - ${originalPs}` : prefix;
      }
      const newJsonString = JSON.stringify(nodeConfig);
      const newBase64Part = btoa(unescape(encodeURIComponent(newJsonString)));
      return 'vmess://' + newBase64Part;
    } catch (e) {
      console.error("为 vmess 节点添加名称前缀失败，将回退到通用方法。", e);
      return appendToFragment(link, prefix);
    }
  }
  return appendToFragment(link, prefix);
}

/**
 * 检测字符串是否为有效的Base64格式
 * @param {string} str - 要检测的字符串
 * @returns {boolean} - 是否为有效Base64
 */
function isValidBase64(str) {
    // 先移除所有空白字符(空格、换行、回车等)
    const cleanStr = str.replace(/\s/g, '');
    const base64Regex = /^[A-Za-z0-9+\/=]+$/;
    return base64Regex.test(cleanStr) && cleanStr.length > 20;
}

/**
 * 根据客户端类型确定合适的用户代理
 * 参考CF-Workers-SUB的优雅策略：统一使用v2rayN UA获取订阅，简单而有效
 * @param {string} originalUserAgent - 原始用户代理字符串
 * @returns {string} - 处理后的用户代理字符串
 */
function getProcessedUserAgent(originalUserAgent, url = '') {
    if (!originalUserAgent) return originalUserAgent;
    
    // CF-Workers-SUB的精华策略：
    // 统一使用v2rayN UA获取订阅，绕过机场过滤同时保证获取完整节点
    // 不需要复杂的客户端判断，简单而有效
    return 'v2rayN/6.45';
}

// --- 节点列表生成函数 ---
async function generateCombinedNodeList(context, config, userAgent, misubs, prependedContent = '', profilePrefixSettings = null) {
    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//g;
    
    // 判断是否启用手动节点前缀
    const shouldPrependManualNodes = profilePrefixSettings?.enableManualNodes ?? 
        config.prefixConfig?.enableManualNodes ?? 
        config.prependSubName ?? true;
    
    // 手动节点前缀文本
    const manualNodePrefix = profilePrefixSettings?.manualNodePrefix ?? 
        config.prefixConfig?.manualNodePrefix ?? 
        '手动节点';
    
    const processedManualNodes = misubs.filter(sub => !sub.url.toLowerCase().startsWith('http')).map(node => {
        if (node.isExpiredNode) {
            return node.url; // Directly use the URL for expired node
        } else {
            // 修复手动SS节点中的URL编码问题
            let processedUrl = node.url;
            if (processedUrl.startsWith('ss://')) {
                try {
                    const hashIndex = processedUrl.indexOf('#');
                    let baseLink = hashIndex !== -1 ? processedUrl.substring(0, hashIndex) : processedUrl;
                    let fragment = hashIndex !== -1 ? processedUrl.substring(hashIndex) : '';
                    
                    // 检查base64部分是否包含URL编码字符
                    const protocolEnd = baseLink.indexOf('://');
                    const atIndex = baseLink.indexOf('@');
                    if (protocolEnd !== -1 && atIndex !== -1) {
                        const base64Part = baseLink.substring(protocolEnd + 3, atIndex);
                        if (base64Part.includes('%')) {
                            // 解码URL编码的base64部分
                            const decodedBase64 = decodeURIComponent(base64Part);
                            baseLink = 'ss://' + decodedBase64 + baseLink.substring(atIndex);
                        }
                    }
                    processedUrl = baseLink + fragment;
                } catch (e) {
                    // 如果处理失败，使用原始链接
                }
            }
            
            return shouldPrependManualNodes ? prependNodeName(processedUrl, manualNodePrefix) : processedUrl;
        }
    }).join('\n');

    const httpSubs = misubs.filter(sub => sub.url.toLowerCase().startsWith('http'));
    const subPromises = httpSubs.map(async (sub) => {
        try {
            // 使用处理后的用户代理
            const processedUserAgent = getProcessedUserAgent(userAgent, sub.url);
            const requestHeaders = { 'User-Agent': processedUserAgent };
            const response = await Promise.race([
                fetch(new Request(sub.url, { 
                    headers: requestHeaders, 
                    redirect: "follow", 
                    cf: { 
                        insecureSkipVerify: true,
                        allowUntrusted: true,
                        validateCertificate: false
                    } 
                })),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 8000))
            ]);
            if (!response.ok) {
                console.warn(`订阅请求失败: ${sub.url}, 状态: ${response.status}`);
                return '';
            }
            let text = await response.text();
            
            // 智能内容类型检测 - 更精确的判断条件
            if (text.includes('proxies:') && text.includes('rules:')) {
                // 这是完整的Clash配置文件，不是节点列表
                return '';
            } else if (text.includes('outbounds') && text.includes('inbounds') && text.includes('route')) {
                // 这是完整的Singbox配置文件，不是节点列表
                return '';
            }
            try {
                const cleanedText = text.replace(/\s/g, '');
                if (isValidBase64(cleanedText)) {
                    const binaryString = atob(cleanedText);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
                    text = new TextDecoder('utf-8').decode(bytes);
                }
            } catch (e) {
                // Base64解码失败，使用原始内容
            }
            let validNodes = text.replace(/\r\n/g, '\n').split('\n')
                .map(line => line.trim())
                .filter(line => /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//.test(line))
                .map(line => {
                    // 修复SS节点中的URL编码问题
                    if (line.startsWith('ss://') || line.startsWith('vless://') || line.startsWith('trojan://')) {
                        try {
                            const hashIndex = line.indexOf('#');
                            let baseLink = hashIndex !== -1 ? line.substring(0, hashIndex) : line;
                            let fragment = hashIndex !== -1 ? line.substring(hashIndex) : '';
                            
                            // 检查base64部分是否包含URL编码字符
                            const protocolEnd = baseLink.indexOf('://');
                            const atIndex = baseLink.indexOf('@');
                            if (protocolEnd !== -1 && atIndex !== -1) {
                                const base64Part = baseLink.substring(protocolEnd + 3, atIndex);
                                if (base64Part.includes('%')) {
                                    // 解码URL编码的base64部分
                                    const decodedBase64 = decodeURIComponent(base64Part);
                                    const protocol = baseLink.substring(0, protocolEnd);
                                    baseLink = protocol + '://' + decodedBase64 + baseLink.substring(atIndex);
                                }
                            }
                            return baseLink + fragment;
                        } catch (e) {
                            // 如果处理失败，返回原始链接
                            return line;
                        }
                    }
                    return line;
                });

            // [核心重構] 引入白名單 (keep:) 和黑名單 (exclude) 模式
            if (sub.exclude && sub.exclude.trim() !== '') {
                const rules = sub.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
                
                const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));

                if (keepRules.length > 0) {
                    // --- 白名單模式 (Inclusion Mode) ---
                    const nameRegexParts = [];
                    const protocolsToKeep = new Set();

                    keepRules.forEach(rule => {
                        const content = rule.substring('keep:'.length).trim();
                        if (content.toLowerCase().startsWith('proto:')) {
                            const protocols = content.substring('proto:'.length).split(',').map(p => p.trim().toLowerCase());
                            protocols.forEach(p => protocolsToKeep.add(p));
                        } else {
                            nameRegexParts.push(content);
                        }
                    });

                    const nameRegex = nameRegexParts.length > 0 ? new RegExp(nameRegexParts.join('|'), 'i') : null;
                    
                    validNodes = validNodes.filter(nodeLink => {
                        // 檢查協議是否匹配
                        const protocolMatch = nodeLink.match(/^(.*?):\/\//);
                        const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
                        if (protocolsToKeep.has(protocol)) {
                            return true;
                        }

                        // 檢查名稱是否匹配
                        if (nameRegex) {
                            const hashIndex = nodeLink.lastIndexOf('#');
                            if (hashIndex !== -1) {
                                try {
                                    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
                                    if (nameRegex.test(nodeName)) {
                                        return true;
                                    }
                                } catch (e) { /* 忽略解碼錯誤 */ }
                            }
                        }
                        return false; // 白名單模式下，不匹配任何規則則排除
                    });

                } else {
                    // --- 黑名單模式 (Exclusion Mode) ---
                    const protocolsToExclude = new Set();
                    const nameRegexParts = [];

                    rules.forEach(rule => {
                        if (rule.toLowerCase().startsWith('proto:')) {
                            const protocols = rule.substring('proto:'.length).split(',').map(p => p.trim().toLowerCase());
                            protocols.forEach(p => protocolsToExclude.add(p));
                        } else {
                            nameRegexParts.push(rule);
                        }
                    });
                    
                    const nameRegex = nameRegexParts.length > 0 ? new RegExp(nameRegexParts.join('|'), 'i') : null;

                    validNodes = validNodes.filter(nodeLink => {
                        const protocolMatch = nodeLink.match(/^(.*?):\/\//);
                        const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
                        if (protocolsToExclude.has(protocol)) {
                            return false;
                        }

                        if (nameRegex) {
                            const hashIndex = nodeLink.lastIndexOf('#');
                            if (hashIndex !== -1) {
                                try {
                                    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
                                    if (nameRegex.test(nodeName)) {
                                        return false;
                                    }
                                } catch (e) { /* 忽略解碼錯誤 */ }
                            }
                            // 修复：对于vmess协议，需要特殊处理节点名称
                            else if (protocol === 'vmess') {
                                try {
                                    // 提取vmess链接中的Base64部分
                                    const base64Part = nodeLink.substring('vmess://'.length);
                                    // 解码Base64
                                    const binaryString = atob(base64Part);
                                    const bytes = new Uint8Array(binaryString.length);
                                    for (let i = 0; i < binaryString.length; i++) {
                                        bytes[i] = binaryString.charCodeAt(i);
                                    }
                                    const jsonString = new TextDecoder('utf-8').decode(bytes);
                                    const nodeConfig = JSON.parse(jsonString);
                                    const nodeName = nodeConfig.ps || '';
                                    if (nameRegex.test(nodeName)) {
                                        return false;
                                    }
                                } catch (e) { /* 忽略解码错误 */ }
                            }
                        }
                        return true;
                    });
                }
            }
            
            // 判断是否启用订阅前缀
            const shouldPrependSubscriptions = profilePrefixSettings?.enableSubscriptions ?? 
                config.prefixConfig?.enableSubscriptions ?? 
                config.prependSubName ?? true;
            
            return (shouldPrependSubscriptions && sub.name)
                ? validNodes.map(node => prependNodeName(node, sub.name)).join('\n')
                : validNodes.join('\n');
        } catch (e) { 
            // 订阅处理错误，生成错误节点
            const errorNodeName = `连接错误-${sub.name || '未知'}`;
            return `trojan://error@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp#${encodeURIComponent(errorNodeName)}`;
        }
    });
    const processedSubContents = await Promise.all(subPromises);
    const combinedContent = (processedManualNodes + '\n' + processedSubContents.join('\n'));
    const uniqueNodesString = [...new Set(combinedContent.split('\n').map(line => line.trim()).filter(line => line))].join('\n');

    // 确保最终的字符串在非空时以换行符结束，以兼容 subconverter
    let finalNodeList = uniqueNodesString;
    if (finalNodeList.length > 0 && !finalNodeList.endsWith('\n')) {
        finalNodeList += '\n';
    }

    // 将虚假节点（如果存在）插入到列表最前面
    if (prependedContent) {
        return `${prependedContent}\n${finalNodeList}`;
    }
    return finalNodeList;
}

// ============================================
// 订阅格式处理公共函数
// ============================================

/**
 * 判断目标订阅格式
 * @param {URL} url - 请求URL
 * @param {string} userAgent - User-Agent字符串
 * @param {string} effectiveSubConfig - 订阅配置（可选，用于降级判断）
 * @returns {string} - 目标格式（clash/singbox/surge/loon/mixed/base64等）
 */
function determineTargetFormat(url, userAgent, effectiveSubConfig = null) {
    let targetFormat = url.searchParams.get('target');
    
    if (!targetFormat) {
        const supportedFormats = ['clash', 'singbox', 'surge', 'loon', 'shadowrocket', 'mixed', 'base64', 'v2ray', 'trojan'];
        for (const format of supportedFormats) {
            if (url.searchParams.has(format)) {
                if (format === 'v2ray' || format === 'trojan') {
                    targetFormat = 'base64';
                } else if (format === 'shadowrocket') {
                    // 兼容 ?shadowrocket=1，内部统一映射为 subconverter 支持的 mixed
                    targetFormat = 'mixed';
                } else {
                    targetFormat = format;
                }
                break;
            }
        }
    }
    
    if (!targetFormat) {
        const ua = userAgent.toLowerCase();
        const uaMapping = [
            ['flyclash', 'clash'],
            ['openclash', 'clash'],
            ['mihomo', 'clash'],
            ['clash.meta', 'clash'],
            ['clash-verge', 'clash'],
            ['meta', 'clash'],
            ['stash', 'clash'],
            ['nekoray', 'clash'],
            ['sing-box', 'singbox'],
            // Shadowrocket 使用 subconverter 的 mixed 目标，输出标准混合订阅（包含 SSR 等协议）
            ['shadowrocket', 'mixed'],
            ['v2rayn', 'base64'],
            ['v2rayng', 'base64'],
            ['surge', 'surge'],
            ['loon', 'loon'],
            ['quantumult%20x', 'quanx'],
            ['quantumult', 'quanx'],
            ['clash', 'clash']
        ];
        
        for (const [keyword, format] of uaMapping) {
            if (ua.includes(keyword)) {
                targetFormat = format;
                break;
            }
        }
    }
    
    // 降级逻辑：如果格式需要SubConfig但未配置
    // 注意：Clash不能降级到base64（Clash客户端只支持yaml格式）
    // Loon和Surge可以降级到base64（通用格式）
    // Shadowrocket 依赖 subconverter 生成专用配置，但不强制要求 SubConfig，可直接使用通用分组
    if (targetFormat && (targetFormat === 'loon' || targetFormat === 'surge')) {
        if (!effectiveSubConfig || effectiveSubConfig.trim() === '') {
            console.log(`[Format] ${targetFormat} requires SubConfig but not configured, fallback to base64 (universal format)`);
            targetFormat = 'base64';
        }
    }
    
    // Clash格式特殊处理：即使没有SubConfig也保持clash格式，后续会生成最小化配置
    if (targetFormat === 'clash' && (!effectiveSubConfig || effectiveSubConfig.trim() === '')) {
        console.log(`[Format] clash format without SubConfig, will generate minimal yaml config`);
    }
    
    return targetFormat || 'base64';
}

/**
 * 通过订阅转换器处理订阅内容
 * @param {string} combinedNodeList - 组合后的节点列表
 * @param {string} targetFormat - 目标格式
 * @param {URL} url - 请求URL
 * @param {string} callbackPath - 回调路径
 * @param {Object} env - 环境变量
 * @param {string} effectiveSubConverter - 订阅转换器地址
 * @param {string} effectiveSubConfig - 订阅配置
 * @param {string} subName - 订阅名称
 * @param {Object} additionalHeaders - 额外的响应头
 * @returns {Promise<Response>} - 响应对象
 */
async function processViaSubconverter(combinedNodeList, targetFormat, url, callbackPath, env, effectiveSubConverter, effectiveSubConfig, subName, additionalHeaders = {}) {
    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));
    
    // 🔧 特殊处理：Clash格式但没有SubConfig时，使用内置的极简配置
    if (targetFormat === 'clash' && (!effectiveSubConfig || effectiveSubConfig.trim() === '')) {
        console.log('[Clash] No SubConfig provided, using built-in minimal config');
        
        // 使用极简配置（只有基础规则：中国直连+其他走代理）
        // 配置特点：
        // - 1条规则：中国IP直连
        // - 2个代理组：代理（包含所有节点）、规则外路由选择
        // - 不按地区分组，适合节点少的场景
        effectiveSubConfig = 'https://gist.githubusercontent.com/tindy2013/1fa08640a9088ac8652dbd40c5d2715b/raw/lhie1_clash.ini';
        
        console.log(`[Clash] Using minimal config: ${effectiveSubConfig}`);
    }
    
    // 生成callback URL
    const callbackToken = await getCallbackToken(env);
    const callbackUrl = `${url.protocol}//${url.host}${callbackPath}?target=base64&callback_token=${callbackToken}`;
    
    // 如果是订阅转换器的回调请求，直接返回base64内容
    if (url.searchParams.get('callback_token') === callbackToken) {
        return new Response(base64Content, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store, no-cache'
            }
        });
    }
    
    // 请求订阅转换器
    const subconverterUrl = new URL(`https://${effectiveSubConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);
    subconverterUrl.searchParams.set('url', callbackUrl);
    if ((targetFormat === 'clash' || targetFormat === 'loon' || targetFormat === 'surge') && effectiveSubConfig && effectiveSubConfig.trim() !== '') {
        subconverterUrl.searchParams.set('config', effectiveSubConfig);
    }
    subconverterUrl.searchParams.set('new_name', 'true');
    
    // 调试日志
    console.log(`[Subconverter] Requesting: ${subconverterUrl.toString()}`);
    console.log(`[Subconverter] Callback URL: ${callbackUrl}`);
    console.log(`[Subconverter] Target: ${targetFormat}, SubConfig: ${effectiveSubConfig ? 'configured' : 'not configured'}`);
    
    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        
        if (!subconverterResponse.ok) {
            const errorBody = await subconverterResponse.text();
            throw new Error(`Subconverter service returned status: ${subconverterResponse.status}. Body: ${errorBody}`);
        }
        
        const responseText = await subconverterResponse.text();
        
        // 调试日志
        console.log(`[Subconverter] Response length: ${responseText.length} bytes`);
        console.log(`[Subconverter] Response preview: ${responseText.substring(0, 500)}`);
        
        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set('Content-Disposition', `attachment; filename*=utf-8''${encodeURIComponent(subName)}`);
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-store, no-cache');
        
        // 添加额外的响应头
        for (const [key, value] of Object.entries(additionalHeaders)) {
            responseHeaders.set(key, value);
        }
        
        return new Response(responseText, {
            status: subconverterResponse.status,
            statusText: subconverterResponse.statusText,
            headers: responseHeaders
        });
    } catch (error) {
        console.error(`[Subconverter Error] ${error.message}`);
        return new Response(`Error connecting to subconverter: ${error.message}`, { status: 502 });
    }
}

// ============================================
// 反共享机制相关函数
// ============================================

/**
 * 生成设备ID（hash User-Agent）
 * @param {string} userAgent - User-Agent字符串
 * @returns {string} - 设备ID（36进制hash）
 */
function getDeviceId(userAgent) {
    let hash = 0;
    for (let i = 0; i < userAgent.length; i++) {
        const char = userAgent.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36); // 返回36进制字符串
}

/**
 * 从IP获取城市信息（简化版，直接使用 Cloudflare 数据或返回 Unknown）
 * 注意：完整的地理信息获取在 performAntiShareCheck 中统一处理，避免重复调用 API
 * @param {Request} request - 请求对象
 * @returns {string} - 城市名称
 */
function getCityFromCF(request) {
    // 快速获取 Cloudflare 提供的城市信息（作为降级方案）
    return (request.cf && request.cf.city) ? request.cf.city : 'Unknown';
}

/**
 * 生成设备数超限错误节点
 * @param {number} deviceCount - 当前设备数
 * @param {number} maxDevices - 最大设备数
 * @returns {string} - Base64编码的错误节点
 */
function generateDeviceLimitError(deviceCount, maxDevices) {
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('⛔ device limit exceeded')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`current: ${deviceCount} devices / limit: ${maxDevices} devices`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('❌ do not share subscription with multiple devices')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('contact service provider for more devices')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 生成错误配置（支持多种客户端格式）
 * @param {string} format - 客户端格式 (clash/surge/loon)
 * @param {string} errorMessage - 错误信息
 * @returns {Response} - 响应对象
 */
function generateErrorConfig(format, errorMessage) {
    let configContent = '';
    let contentType = '';
    
    switch (format.toLowerCase()) {
        case 'clash':
            configContent = `# ⚠️ subscription access limited
# ${errorMessage}
# please contact administrator or wait for limit to be removed

port: 7890
socks-port: 7891
allow-lan: false
mode: Rule
log-level: info

proxies:
  - name: "⚠️ ${errorMessage}"
    type: ss
    server: 127.0.0.1
    port: 1
    cipher: aes-128-gcm
    password: error

proxy-groups:
  - name: "🚫 access limited"
    type: select
    proxies:
      - "⚠️ ${errorMessage}"

rules:
  - MATCH,🚫 access limited
`;
            contentType = 'text/yaml; charset=utf-8';
            break;
            
        case 'surge':
            configContent = `#!MANAGED-CONFIG https://example.com/error

[General]
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local
bypass-system = true
dns-server = system

[Proxy]
⚠️ ${errorMessage} = ss, 127.0.0.1, 1, encrypt-method=aes-128-gcm, password=error

[Proxy Group]
🚫 access limited = select, ⚠️ ${errorMessage}

[Rule]
FINAL,🚫 access limited
`;
            contentType = 'text/plain; charset=utf-8';
            break;
            
        case 'loon':
            configContent = `# ⚠️ subscription access limited
# ${errorMessage}

[General]
skip-proxy = 127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local
dns-server = system

[Proxy]
⚠️ ${errorMessage} = Shadowsocks,127.0.0.1,1,aes-128-gcm,"error"

[Proxy Group]
🚫 access limited = select,⚠️ ${errorMessage}

[Rule]
FINAL,🚫 access limited
`;
            contentType = 'text/plain; charset=utf-8';
            break;
            
        default:
            // default simple error message
            configContent = `⚠️ ${errorMessage}`;
            contentType = 'text/plain; charset=utf-8';
    }
    
    return new Response(configContent, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache',
            'Profile-Title': '⚠️ access limited',
            'Subscription-UserInfo': 'upload=0; download=0; total=0; expire=0'
        }
    });
}

/**
 * 生成新设备+新城市错误节点
 * @returns {string} - Base64编码的错误节点
 */
function generateNewDeviceNewCityError() {
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('🚫 new device + new city')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('detected suspicious sharing behavior')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('❌ please use common nodes or disable proxy')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('to add new device, please use existing cities first')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 生成城市上限超出错误节点
 * @param {number} currentCityCount - 当前城市数
 * @param {number} maxCities - 最大城市数
 * @returns {string} - Base64编码的错误节点
 */
function generateCityLimitError(currentCityCount, maxCities) {
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('🌍 city limit')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`current: ${currentCityCount} cities / limit: ${maxCities} cities`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('❌ account has reached city limit')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('please use existing cities or contact service provider')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 生成已存在设备+新城市错误节点
 * @param {string} deviceId - 设备ID
 * @param {Array<string>} existingCities - 已存在的城市列表
 * @param {string} newCity - 当前城市
 * @param {number} cityCount - 当前城市数量
 * @param {number} maxCities - 最大城市数量
 * @returns {string} - Base64编码的错误节点
 */
function generateExistingDeviceNewCityError(deviceId, existingCities, newCity, cityCount, maxCities) {
    const cityList = existingCities.join(', ');
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('🌍 this city is not a common city')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`account cities (${cityCount}/${maxCities}): ${cityList}`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`current city: ${newCity}`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('❌ please use common nodes or disable proxy and retry')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('if this persists, please contact service provider')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 生成访问次数超限错误节点
 * @param {number} dailyCount - 今日访问次数
 * @param {number} rateLimit - 访问次数限制
 * @param {number} deviceCount - 当前设备数
 * @returns {string} - Base64编码的错误节点
 */
function generateRateLimitError(dailyCount, rateLimit, deviceCount) {
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('⏰ today access limit')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`access count: ${dailyCount} times / limit: ${rateLimit} times`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`current device count: ${deviceCount} devices`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('⏳ reset access limit at 00:00 tomorrow(UTC+8)')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('or reduce device count to get more access limit')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 生成账号临时封禁错误节点
 * @param {number} suspendUntil - 封禁到期时间戳
 * @param {string} suspendReason - 封禁原因
 * @returns {string} - Base64编码的错误节点
 */
function generateSuspendError(suspendUntil, suspendReason) {
    const unfreezeDate = new Date(suspendUntil).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
    const remainingDays = Math.ceil((suspendUntil - Date.now()) / (1000 * 60 * 60 * 24));
    const errorNodes = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('🚫 account temporarily suspended')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`reason: ${suspendReason}`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`remaining suspension: ${remainingDays} days`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(`unsuspend time: ${unfreezeDate}`)}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('⏳ auto unsuspend after expiration')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('if urgent, please contact service provider')}`
    ];
    return errorNodes.join('\n');
}

/**
 * 反共享检测核心函数
 * @param {string} userToken - 用户Token
 * @param {Object} userData - 用户数据
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} config - 反共享配置对象（从 getConfig() 获取）
 * @param {Object} settings - Telegram等设置（包含 BotToken、ChatID 等）
 * @param {Object} context - 上下文对象
 * @param {Object} profile - 订阅组对象（可选，用于检查是否在测试模式）
 * @returns {Promise<Object>} - 检测结果 { allowed: boolean, reason?: string, ... }
 */
async function performAntiShareCheck(userToken, userData, request, env, config, settings, context, profile = null) {
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    // 使用多层降级获取 IP（与 sendEnhancedTgNotification 保持一致）
    const clientIp = request.headers.get('CF-Connecting-IP') 
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || request.headers.get('X-Real-IP')
        || 'Unknown';
    const storageAdapter = await getStorageAdapter(env);
    
    // 【通知检查】判断是否应该发送 Telegram 通知
    // 1. 检查全局开关
    const asyncConfig = getConfig();
    const telegramConfig = asyncConfig.telegram;
    const shouldDisableNotifications = !telegramConfig.GLOBAL_NOTIFY_ENABLED;
    
    // 2. 检查是否在测试模式（basic 预设 = 共享模式）
    const isTestMode = profile && profile.policyKey === 'basic' && telegramConfig.DISABLE_NOTIFY_IN_TEST_MODE;
    
    // 3. 决定是否发送通知
    const shouldSendNotifications = !shouldDisableNotifications && !isTestMode;
    
    if (isTestMode) {
        console.log(`[AntiShare] Test mode detected (basic preset), notifications disabled for user ${userToken}`);
    }
    const remarkLine = userData.remark ? `\n*备注:* \`${userData.remark}\`` : '';
    
    // 【通知包装函数】自动检查是否应该发送通知
    const sendNotificationIfEnabled = async (type, additionalData, city) => {
        if (shouldSendNotifications) {
            return await sendEnhancedTgNotification(settings, type, request, additionalData, city);
        }
        return false;
    };
    
    // 1. 获取设备ID（hash User-Agent）
    const deviceId = getDeviceId(userAgent);
    
    // 2. 【统一】获取城市信息（只调用一次 GeoIP API，复用结果）
    // 使用与 Telegram 通知完全相同的逻辑
    const apiPriority = config.geoip?.API_PRIORITY || ['ipgeolocation.io', 'ipwhois.io', 'ip-api.com', 'cloudflare'];
    const apiTimeout = config.geoip?.API_TIMEOUT_MS || 3000;
    let city = 'Unknown';
    let geoApiUsed = 'none';
    
    // API 调用函数映射表（与 sendEnhancedTgNotification 完全一致）
    const apiHandlers = {
        'ipgeolocation.io': async () => {
            if (!settings.IPGeoAPIKey) return null;
            try {
                const response = await fetch(
                    `https://api.ipgeolocation.io/ipgeo?apiKey=${settings.IPGeoAPIKey}&ip=${clientIp}`,
                    { signal: AbortSignal.timeout(apiTimeout) }
                );
                if (!response.ok) return null;
                const data = await response.json();
                return data.city || null;
            } catch { return null; }
        },
        'ipwhois.io': async () => {
            try {
                const response = await fetch(
                    `https://ipwhois.app/json/${clientIp}?lang=zh-CN`,
                    { signal: AbortSignal.timeout(apiTimeout) }
                );
                if (!response.ok) return null;
                const data = await response.json();
                return (data.success !== false && data.city) ? data.city : null;
            } catch { return null; }
        },
        'ip-api.com': async () => {
            try {
                const response = await fetch(
                    `http://ip-api.com/json/${clientIp}?lang=zh-CN`,
                    { signal: AbortSignal.timeout(apiTimeout) }
                );
                if (!response.ok) return null;
                const data = await response.json();
                return (data.status === 'success' && data.city) ? data.city : null;
            } catch { return null; }
        },
        'cloudflare': async () => {
            return (request.cf && request.cf.city) ? request.cf.city : null;
        }
    };
    
    // 按优先级尝试各个 API（只调用一次）
    for (const apiName of apiPriority) {
        const handler = apiHandlers[apiName];
        if (!handler) continue;
        
        try {
            const result = await handler();
            if (result) {
                city = result;
                geoApiUsed = apiName;
                console.log(`[GeoIP] Success: ${geoApiUsed} -> ${city}`);
                break;
            }
        } catch (error) {
            console.log(`[GeoIP] ${apiName} failed:`, error.message);
        }
    }
    
    const cityKey = city.toLowerCase();
    
    // 3. 初始化数据结构
    if (!userData.devices) {
        userData.devices = {};
    }
    
    if (!userData.stats) {
        userData.stats = {
            totalRequests: 0,
            lastRequest: null,
            dailyCount: 0,
            dailyDate: null,
            failedAttempts: 0,
            rateLimitAttempts: 0
        };
    }
    
    // 确保新字段存在（向后兼容）
    if (userData.stats.failedAttempts === undefined) {
        userData.stats.failedAttempts = 0;
    }
    if (userData.stats.rateLimitAttempts === undefined) {
        userData.stats.rateLimitAttempts = 0;
    }
    
    // 3.5 【检测0】账号临时封禁检测（优先级最高）
    if (userData.suspend) {
        const now = Date.now();
        
        // 🔧 策略切换时重新计算封禁时长
        // 如果当前策略的封禁时长更短，允许提前解封
        if (userData.suspend.at && userData.suspend.until) {
            const originalDuration = userData.suspend.until - userData.suspend.at;
            const currentDuration = (config.antiShare.SUSPEND_DURATION_DAYS) * 86400000;  // 使用有效配置
            
            // 如果新策略的封禁时长更短，重新计算 until
            if (currentDuration < originalDuration) {
                const newUntil = userData.suspend.at + currentDuration;
                console.log(`[AntiShare] Policy changed, recalculating suspend duration:`, {
                    original: `${(originalDuration / 86400000).toFixed(2)} days`,
                    new: `${(currentDuration / 86400000).toFixed(2)} days`,
                    oldUntil: new Date(userData.suspend.until).toISOString(),
                    newUntil: new Date(newUntil).toISOString()
                });
                userData.suspend.until = newUntil;
                
                // 保存更新后的封禁信息
                await storageAdapter.put(`user:${userToken}`, userData);
            }
        }
        
        // 检查封禁是否已过期
        if (userData.suspend.until && now >= userData.suspend.until) {
            // 封禁已过期，自动解冻
            console.log(`[AntiShare] Account ${userToken} auto-unfrozen after suspension`);
            
            // 部分重置计数器（中间方案）：降低到阈值的60%，既保留"案底"又给缓冲空间
            const failedThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
            const rateLimitThreshold = config.antiShare.SUSPEND_RATE_LIMIT_ATTEMPTS_THRESHOLD;
            const oldFailedAttempts = userData.stats.failedAttempts || 0;
            const oldRateLimitAttempts = userData.stats.rateLimitAttempts || 0;
            
            userData.stats.failedAttempts = Math.floor(failedThreshold * 0.6);  // 例如：5 → 3
            userData.stats.rateLimitAttempts = Math.floor(rateLimitThreshold * 0.6);  // 例如：10 → 6
            
            // 发送解封通知
            if (config.telegram.NOTIFY_ON_NEW_DEVICE) {
                const additionalData = `*Token:* \`${userToken}\`
*解封时间:* \`${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\`
*状态:* ✅ 封禁已过期，账号已自动恢复

*计数器调整:*
- 失败尝试: \`${oldFailedAttempts}\` → \`${userData.stats.failedAttempts}\` 次（阈值: ${failedThreshold}次）
- 达到上限后尝试: \`${oldRateLimitAttempts}\` → \`${userData.stats.rateLimitAttempts}\` 次（阈值: ${rateLimitThreshold}次）

⚠️ 如继续违规，将更快触发再次封禁。${remarkLine}`;
                context.waitUntil(sendNotificationIfEnabled('✅ *账号已自动解封*', additionalData, city));
            }
            
            delete userData.suspend;
            
            // 保存解封状态
            await storageAdapter.put(`user:${userToken}`, userData);
        } else {
            // 封禁仍然有效，拒绝访问
            console.log(`[AntiShare] Account ${userToken} is suspended until ${new Date(userData.suspend.until).toISOString()}`);
            
            return {
                allowed: false,
                reason: 'suspended',
                suspendUntil: userData.suspend.until,
                suspendReason: userData.suspend.reason || '可疑的高频访问行为'
            };
        }
    }
    
    // 4. 判断设备和城市是否存在
    const isNewDevice = !userData.devices[deviceId];
    const deviceCount = Object.keys(userData.devices).length;
    
    // 【检测1】设备数量限制（新设备才检查）
    if (isNewDevice && deviceCount >= config.antiShare.MAX_DEVICES) {
        // 记录失败尝试次数
        userData.stats.failedAttempts = (userData.stats.failedAttempts || 0) + 1;
        
        // 🔍 立即检查是否需要触发封禁
        if (config.antiShare.SUSPEND_ENABLED) {
            const failedAttemptsThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
            
            if (userData.stats.failedAttempts >= failedAttemptsThreshold) {
                // 触发临时封禁
                const suspendDurationMs = config.antiShare.SUSPEND_DURATION_DAYS * 24 * 60 * 60 * 1000;
                const suspendUntil = Date.now() + suspendDurationMs;
                const suspendReason = `可疑的高频失败尝试（${userData.stats.failedAttempts}次失败尝试，疑似账号共享或滥用）`;
                
                userData.suspend = {
                    at: Date.now(),
                    until: suspendUntil,
                    reason: suspendReason,
                    deviceCount: deviceCount,
                    failedAttempts: userData.stats.failedAttempts
                };
                
                // 发送Telegram封禁通知
                const unfreezeDate = new Date(suspendUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                
                // 格式化封禁时长
                let durationText = '';
                const days = config.antiShare.SUSPEND_DURATION_DAYS;
                if (days >= 1) {
                    durationText = `${days}天`;
                } else if (days >= 1/24) {
                    const hours = Math.round(days * 24);
                    durationText = `${hours}小时`;
                } else {
                    const minutes = Math.round(days * 24 * 60);
                    durationText = `${minutes}分钟`;
                }
                
                const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*封禁时长:* ${durationText}
*解封时间:* \`${unfreezeDate}\`

*触发原因:*
- 失败尝试: \`${userData.stats.failedAttempts}\` 次（阈值: ${failedAttemptsThreshold}次）
- 已有设备数: \`${deviceCount}\`
- ⚠️ 疑似账号共享或滥用（频繁尝试添加超限设备）${remarkLine}`;
                
                context.waitUntil(sendNotificationIfEnabled('🚫 *账号已临时封禁*', additionalData, city));
                console.log(`[AntiShare] Account ${userToken} suspended until ${unfreezeDate} (failedAttempts: ${userData.stats.failedAttempts})`);
                
                // 保存封禁状态
                await storageAdapter.put(`user:${userToken}`, userData);
                
                return {
                    allowed: false,
                    reason: 'suspended',
                    suspendUntil,
                    suspendReason
                };
            }
        }
        
        // 发送设备数超限通知
        if (config.telegram.NOTIFY_ON_DEVICE_LIMIT) {
            const additionalData = `*Token:* \`${userToken}\`
*已有设备数:* \`${deviceCount}\`
*限制数量:* \`${config.antiShare.MAX_DEVICES}\`
*尝试添加:* 第${deviceCount + 1}台设备
*新设备ID:* \`${deviceId}\`
*新设备UA:* \`${userAgent}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*失败尝试:* \`${userData.stats.failedAttempts}\` 次（阈值: ${config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD}次）${remarkLine}`;
            context.waitUntil(sendNotificationIfEnabled('🚫 *设备数超限*', additionalData, city));
        }
        
        // 保存failedAttempts
        await storageAdapter.put(`user:${userToken}`, userData);
        
        return {
            allowed: false,
            reason: 'device_limit',
            deviceCount,
            maxDevices: config.antiShare.MAX_DEVICES,
            failedAttempts: userData.stats.failedAttempts
        };
    }
    
    // 5. 【城市检测前置】先检查城市，避免提前初始化设备
    // 判断是否需要城市检测（基于当前设备数，不包含新设备）
    // CITY_CHECK_START_INDEX 表示前N台畅通无阻，从第N+1台开始检测
    const potentialDeviceCount = isNewDevice ? deviceCount + 1 : deviceCount;
    const shouldCheckCity = potentialDeviceCount > config.antiShare.CITY_CHECK_START_INDEX;
    
    // 【城市上限检测】始终执行，对所有设备都有效
    // 获取整个账户下所有设备的所有城市key（小写，去重）
    const allCityKeysSet = new Set();
    const allCitiesForDisplay = [];
    Object.values(userData.devices).forEach(dev => {
        Object.values(dev.cities).forEach(cityInfo => {
            const key = cityInfo.city.toLowerCase();
            if (!allCityKeysSet.has(key)) {
                allCityKeysSet.add(key);
                allCitiesForDisplay.push(cityInfo.city);
            }
        });
    });
    
    const maxCities = config.antiShare.MAX_CITIES;
    const cityExists = allCityKeysSet.has(cityKey);
    
    // 【硬性限制】城市总数不能超过 MAX_CITIES（对所有设备都适用）
    if (!cityExists && allCityKeysSet.size >= maxCities) {
        // 已达城市上限，拒绝新城市
        if (config.telegram.NOTIFY_ON_CITY_MISMATCH) {
            const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*设备UA:* \`${userAgent}\`
*账户已有城市:* \`${allCitiesForDisplay.join(', ')}\` (${allCityKeysSet.size}/${maxCities})
*当前城市:* \`${city}\`
*设备数:* \`${deviceCount}\`
*IP:* \`${clientIp}\`
*原因:* 账户已达城市上限（${maxCities}个城市），无法添加新城市${remarkLine}`;
            context.waitUntil(sendNotificationIfEnabled('🌍 *城市上限*', additionalData, city));
        }
        
        // 记录失败尝试次数
        userData.stats.failedAttempts = (userData.stats.failedAttempts || 0) + 1;
        
        // 🔍 立即检查是否需要触发封禁
        if (config.antiShare.SUSPEND_ENABLED) {
            const failedAttemptsThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
            
            if (userData.stats.failedAttempts >= failedAttemptsThreshold) {
                // 触发临时封禁
                const suspendDurationMs = config.antiShare.SUSPEND_DURATION_DAYS * 24 * 60 * 60 * 1000;
                const suspendUntil = Date.now() + suspendDurationMs;
                const suspendReason = `可疑的高频失败尝试（${userData.stats.failedAttempts}次失败尝试，疑似账号共享或滥用）`;
                
                userData.suspend = {
                    at: Date.now(),
                    until: suspendUntil,
                    reason: suspendReason,
                    deviceCount: deviceCount,
                    failedAttempts: userData.stats.failedAttempts
                };
                
                // 发送Telegram封禁通知
                const unfreezeDate = new Date(suspendUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                
                // 格式化封禁时长
                let durationText = '';
                const days = config.antiShare.SUSPEND_DURATION_DAYS;
                if (days >= 1) {
                    durationText = `${days}天`;
                } else if (days >= 1/24) {
                    const hours = Math.round(days * 24);
                    durationText = `${hours}小时`;
                } else {
                    const minutes = Math.round(days * 24 * 60);
                    durationText = `${minutes}分钟`;
                }
                
                const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*封禁时长:* ${durationText}
*解封时间:* \`${unfreezeDate}\`

*触发原因:*
- 失败尝试: \`${userData.stats.failedAttempts}\` 次（阈值: ${failedAttemptsThreshold}次）
- 已有设备数: \`${deviceCount}\`
- ⚠️ 尝试超过城市上限${remarkLine}`;
                
                context.waitUntil(sendNotificationIfEnabled('🚫 *账号已临时封禁*', additionalData, city));
                console.log(`[AntiShare] Account ${userToken} suspended until ${unfreezeDate} (failedAttempts: ${userData.stats.failedAttempts})`);
                
                // 保存封禁状态
                await storageAdapter.put(`user:${userToken}`, userData);
                
                return {
                    allowed: false,
                    reason: 'suspended',
                    suspendUntil,
                    suspendReason
                };
            }
        }
        
        // 保存failedAttempts
        await storageAdapter.put(`user:${userToken}`, userData);
        
        return {
            allowed: false,
            reason: 'city_limit_exceeded',
            currentCityCount: allCityKeysSet.size,
            maxCities,
            failedAttempts: userData.stats.failedAttempts
        };
    }
    
    // 【可疑性检测】只在设备数达到阈值后才检测"新设备新城市"的可疑性
    if (shouldCheckCity) {
        if (isNewDevice) {
            // 【情况2】新设备
            if (cityExists) {
                // 2.1: 新设备 + 已存在城市 → ✅ 放行（设备将在后续初始化）
                console.log(`[AntiShare] New device with existing city allowed: ${deviceId} → ${city}`);
            } else {
                // 2.2: 新设备 + 新城市 → ❌ 拒绝（可疑共享）
                if (config.telegram.NOTIFY_ON_CITY_MISMATCH) {
                    const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*设备UA:* \`${userAgent}\`
*账户已有城市:* \`${allCitiesForDisplay.length > 0 ? allCitiesForDisplay.join(', ') : '无'}\`
*当前城市:* \`${city}\`
*已有设备数:* \`${deviceCount}\`
*尝试添加:* 第${deviceCount + 1}台设备
*IP:* \`${clientIp}\`
*原因:* 新设备访问新城市，请用常用节点或关闭代理后尝试更新${remarkLine}`;
                    context.waitUntil(sendNotificationIfEnabled('🚫 *新设备新城市*', additionalData, city));
                }
                
                // 记录失败尝试次数
                userData.stats.failedAttempts = (userData.stats.failedAttempts || 0) + 1;
                
                // 🔍 立即检查是否需要触发封禁
                if (config.antiShare.SUSPEND_ENABLED) {
                    const failedAttemptsThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
                    
                    if (userData.stats.failedAttempts >= failedAttemptsThreshold) {
                        // 触发临时封禁
                        const suspendDurationMs = config.antiShare.SUSPEND_DURATION_DAYS * 24 * 60 * 60 * 1000;
                        const suspendUntil = Date.now() + suspendDurationMs;
                        const suspendReason = `可疑的高频失败尝试（${userData.stats.failedAttempts}次失败尝试，疑似账号共享或滥用）`;
                        
                        userData.suspend = {
                            at: Date.now(),
                            until: suspendUntil,
                            reason: suspendReason,
                            deviceCount: deviceCount,
                            failedAttempts: userData.stats.failedAttempts
                        };
                        
                        // 发送Telegram封禁通知
                        const unfreezeDate = new Date(suspendUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                        
                        // 格式化封禁时长
                        let durationText = '';
                        const days = config.antiShare.SUSPEND_DURATION_DAYS;
                        if (days >= 1) {
                            durationText = `${days}天`;
                        } else if (days >= 1/24) {
                            const hours = Math.round(days * 24);
                            durationText = `${hours}小时`;
                        } else {
                            const minutes = Math.round(days * 24 * 60);
                            durationText = `${minutes}分钟`;
                        }
                        
                        const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*封禁时长:* ${durationText}
*解封时间:* \`${unfreezeDate}\`

*触发原因:*
- 失败尝试: \`${userData.stats.failedAttempts}\` 次（阈值: ${failedAttemptsThreshold}次）
- 已有设备数: \`${deviceCount}\`
- ⚠️ 新设备访问新城市（可疑共享）`;
                        
                        context.waitUntil(sendNotificationIfEnabled('🚫 *账号已临时封禁*', additionalData, city));
                        console.log(`[AntiShare] Account ${userToken} suspended until ${unfreezeDate} (failedAttempts: ${userData.stats.failedAttempts})`);
                        
                        // 保存封禁状态
                        await storageAdapter.put(`user:${userToken}`, userData);
                        
                        return {
                            allowed: false,
                            reason: 'suspended',
                            suspendUntil,
                            suspendReason
                        };
                    }
                }
                
                // 保存failedAttempts
                await storageAdapter.put(`user:${userToken}`, userData);
                
                return {
                    allowed: false,
                    reason: 'new_device_new_city',
                    deviceId,
                    city,
                    failedAttempts: userData.stats.failedAttempts
                };
            }
        } else {
            // 【情况1】已存在设备
            if (!cityExists) {
                // 1.2: 已存在设备 + 新城市
                if (allCityKeysSet.size >= maxCities) {
                    // 1.2.2: 已达上限 → ❌ 拒绝
                    if (config.telegram.NOTIFY_ON_CITY_MISMATCH) {
                        const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*设备UA:* \`${userAgent}\`
*账户已有城市:* \`${allCitiesForDisplay.join(', ')}\` (${allCityKeysSet.size}/${maxCities})
*当前城市:* \`${city}\`
*设备数:* \`${deviceCount}\`
*IP:* \`${clientIp}\`
*原因:* 该城市非常用城市（账户已达${maxCities}个城市上限）${remarkLine}`;
                        context.waitUntil(sendNotificationIfEnabled('🌍 *城市异常*', additionalData, city));
                    }
                    
                    // 记录失败尝试次数
                    userData.stats.failedAttempts = (userData.stats.failedAttempts || 0) + 1;
                    
                    // 🔍 立即检查是否需要触发封禁
                    if (config.antiShare.SUSPEND_ENABLED) {
                        const failedAttemptsThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
                        
                        if (userData.stats.failedAttempts >= failedAttemptsThreshold) {
                            // 触发临时封禁
                            const suspendDurationMs = config.antiShare.SUSPEND_DURATION_DAYS * 24 * 60 * 60 * 1000;
                            const suspendUntil = Date.now() + suspendDurationMs;
                            const suspendReason = `可疑的高频失败尝试（${userData.stats.failedAttempts}次失败尝试，疑似账号共享或滥用）`;
                            
                            userData.suspend = {
                                at: Date.now(),
                                until: suspendUntil,
                                reason: suspendReason,
                                deviceCount: deviceCount,
                                failedAttempts: userData.stats.failedAttempts
                            };
                            
                            // 发送Telegram封禁通知
                            const unfreezeDate = new Date(suspendUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                            
                            // 格式化封禁时长
                            let durationText = '';
                            const days = config.antiShare.SUSPEND_DURATION_DAYS;
                            if (days >= 1) {
                                durationText = `${days}天`;
                            } else if (days >= 1/24) {
                                const hours = Math.round(days * 24);
                                durationText = `${hours}小时`;
                            } else {
                                const minutes = Math.round(days * 24 * 60);
                                durationText = `${minutes}分钟`;
                            }
                            
                            const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*封禁时长:* ${durationText}
*解封时间:* \`${unfreezeDate}\`

*触发原因:*
- 失败尝试: \`${userData.stats.failedAttempts}\` 次（阈值: ${failedAttemptsThreshold}次）
- 已有设备数: \`${deviceCount}\`
- ⚠️ 已有设备访问新城市，超过城市上限${remarkLine}`;
                            
                            context.waitUntil(sendNotificationIfEnabled('🚫 *账号已临时封禁*', additionalData, city));
                            console.log(`[AntiShare] Account ${userToken} suspended until ${unfreezeDate} (failedAttempts: ${userData.stats.failedAttempts})`);
                            
                            // 保存封禁状态
                            await storageAdapter.put(`user:${userToken}`, userData);
                            
                            return {
                                allowed: false,
                                reason: 'suspended',
                                suspendUntil,
                                suspendReason
                            };
                        }
                    }
                    
                    // 保存failedAttempts
                    await storageAdapter.put(`user:${userToken}`, userData);
                    
                    return {
                        allowed: false,
                        reason: 'city_limit_exceeded',
                        currentCityCount: allCityKeysSet.size,
                        maxCities,
                        failedAttempts: userData.stats.failedAttempts
                    };
                }
                // 1.2.1: 未达上限 → ✅ 放行
            }
            // 1.1: 已存在设备 + 已存在城市 → ✅ 放行
        }
    }
    
    // 6. 初始化设备（所有检测通过后才初始化）
    if (isNewDevice) {
        userData.devices[deviceId] = {
            deviceId,
            name: userAgent,  // 直接使用完整的 User-Agent 作为设备名称
            userAgent,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            requestCount: 0,
            cities: {}
        };
        
        // 发送新设备绑定成功通知
        if (config.telegram.NOTIFY_ON_NEW_DEVICE) {
            const newDeviceCount = Object.keys(userData.devices).length;
            const additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*设备UA:* \`${userAgent}\`
*城市:* \`${city}\`
*当前设备数:* \`${newDeviceCount}\`/${config.antiShare.MAX_DEVICES}
*IP:* \`${clientIp}\`
*绑定时间:* \`${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\`${remarkLine}`;
            context.waitUntil(sendNotificationIfEnabled('✅ *新设备绑定成功*', additionalData, city));
        }
    }
    
    const device = userData.devices[deviceId];
    const isNewCity = !device.cities[cityKey];
    const currentDeviceCount = Object.keys(userData.devices).length;
    
    // 【检测3】访问次数限制（按 Asia/Shanghai 本地日期统计）
    const now = new Date();
    const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const today = shanghaiNow.toISOString().split('T')[0];
    
    // 初始化或重置每日计数（每天本地 0 点重置）
    if (!userData.stats.dailyDate || userData.stats.dailyDate !== today) {
        userData.stats.dailyCount = 0;
        userData.stats.dailyDate = today;
        userData.stats.failedAttempts = 0;  // 每天重置失败尝试计数
        userData.stats.rateLimitAttempts = 0;  // 每天重置达到上限后的尝试计数
    }
    
    const rateLimit = config.antiShare.RATE_LIMITS[currentDeviceCount] || 999;
    
    // 【检测3.1】触发临时封禁检测（检测账号共享行为）
    if (config.antiShare.SUSPEND_ENABLED) {
        const deviceAtMax = config.antiShare.SUSPEND_REQUIRE_MAX_DEVICES 
            ? (currentDeviceCount >= config.antiShare.MAX_DEVICES)
            : true;
        
        // 初始化计数器
        const failedAttempts = userData.stats.failedAttempts || 0;  // 其他失败（如新设备新城市）
        const rateLimitAttempts = userData.stats.rateLimitAttempts || 0;  // 达到上限后的失败次数
        
        // 失败次数阈值（从配置读取）
        const rateLimitAttemptsThreshold = config.antiShare.SUSPEND_RATE_LIMIT_ATTEMPTS_THRESHOLD;
        const failedAttemptsThreshold = config.antiShare.SUSPEND_FAILED_ATTEMPTS_THRESHOLD;
        
        // 条件1：达到上限后，失败次数过多（账号共享的关键证据）
        // rateLimitAttempts 只有在 dailyCount >= rateLimit 时才会增加，所以不需要额外判断
        const suspendByRateLimitAttempts = rateLimitAttempts >= rateLimitAttemptsThreshold;
        
        // 条件2：其他类型的失败过多（如新设备新城市）
        const suspendByFailedAttempts = failedAttempts >= failedAttemptsThreshold;
        
        if (deviceAtMax && (suspendByRateLimitAttempts || suspendByFailedAttempts)) {
            // 触发临时封禁
            const suspendDurationMs = config.antiShare.SUSPEND_DURATION_DAYS * 24 * 60 * 60 * 1000;
            const suspendUntil = Date.now() + suspendDurationMs;
            
            // 根据触发原因生成不同的封禁理由
            let suspendReason = '';
            if (suspendByRateLimitAttempts) {
                suspendReason = `Detected account sharing (there were still ${rateLimitAttempts} access attempts after reaching the limit, suspected multi-user sharing).`;
            } else if (suspendByFailedAttempts) {
                suspendReason = `Suspicious high-frequency failed attempts (${failedAttempts} failed attempts, suspected account sharing or abuse).`;
            } else {
                suspendReason = `Suspicious high-frequency access behavior.`;
            }
            
            userData.suspend = {
                at: Date.now(),
                until: suspendUntil,
                reason: suspendReason,
                deviceCount: currentDeviceCount,
                dailyCount: userData.stats.dailyCount,
                rateLimit
            };
            
            // 发送Telegram封禁通知
            const unfreezeDate = new Date(suspendUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            
            // 格式化封禁时长
            let durationText = '';
            const days = config.antiShare.SUSPEND_DURATION_DAYS;
            if (days >= 1) {
                durationText = `${days}天`;
            } else if (days >= 1/24) {
                const hours = Math.round(days * 24);
                durationText = `${hours}小时`;
            } else {
                const minutes = Math.round(days * 24 * 60);
                durationText = `${minutes}分钟`;
            }
            
            let additionalData = `*Token:* \`${userToken}\`
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*封禁时长:* ${durationText}
*解封时间:* \`${unfreezeDate}\`

*触发原因:*`;
            
            if (suspendByRateLimitAttempts) {
                additionalData += `
- 今日访问: \`${userData.stats.dailyCount}\` / \`${rateLimit}\` (${currentDeviceCount}台设备)
- 达到上限后失败: \`${rateLimitAttempts}\` 次（阈值: ${rateLimitAttemptsThreshold}次）
- ⚠️ 检测到账号共享行为（达到上限后仍有大量访问，疑似多人共享）`;
            } else if (suspendByFailedAttempts) {
                additionalData += `
- 失败尝试: \`${failedAttempts}\` 次（阈值: ${failedAttemptsThreshold}次）
- 今日访问: \`${userData.stats.dailyCount}\` / \`${rateLimit}\` (${currentDeviceCount}台设备)
- ⚠️ 疑似账号共享或滥用（如新设备新城市）`;
            } else {
                additionalData += `
- 今日访问: \`${userData.stats.dailyCount}\` / \`${rateLimit}\` (${currentDeviceCount}台设备)
- 达到上限后失败: \`${rateLimitAttempts}\` 次
- ⚠️ 可疑的高频访问行为`;
            }

            additionalData += remarkLine;
            
            context.waitUntil(sendNotificationIfEnabled('🚫 *账号已临时封禁*', additionalData, city));
            
            console.log(`[AntiShare] Account ${userToken} suspended until ${unfreezeDate}`);
            
            // 保存封禁状态
            await storageAdapter.put(`user:${userToken}`, userData);
            
            return {
                allowed: false,
                reason: 'suspended',
                suspendUntil,
                suspendReason
            };
        }
    }
    
    // 【检测3.2】访问次数限制（已达上限）
    if (userData.stats.dailyCount >= rateLimit) {
        // 🔍 关键：记录达到上限后的尝试次数（用于检测账号共享）
        // 正常用户达到上限后不会继续访问，但共享账号会有多人继续尝试
        userData.stats.rateLimitAttempts = (userData.stats.rateLimitAttempts || 0) + 1;
        
        // 发送Telegram通知
        if (config.telegram.NOTIFY_ON_RATE_LIMIT) {
            const additionalData = `*Token:* \`${userToken}\`
*今日访问:* \`${userData.stats.dailyCount}\`
*限制次数:* \`${rateLimit}\` (${currentDeviceCount}台设备)
*达到上限后尝试:* \`${userData.stats.rateLimitAttempts}\` 次
*设备ID:* \`${deviceId}\`
*城市:* \`${city}\`
*IP:* \`${clientIp}\`
*重置时间:* 明天0点(UTC+8)${remarkLine}`;
            context.waitUntil(sendNotificationIfEnabled('⏰ *访问次数超限*', additionalData, city));
        }
        
        // 保存rateLimitAttempts
        await storageAdapter.put(`user:${userToken}`, userData);
        
        return {
            allowed: false,
            reason: 'rate_limit',
            dailyCount: userData.stats.dailyCount,
            rateLimit,
            deviceCount: currentDeviceCount,
            rateLimitAttempts: userData.stats.rateLimitAttempts
        };
    }
    
    // ✅ 通过所有检测
    // 更新设备统计
    if (!device.name) {
        device.name = userAgent;  // 兼容旧设备，补充 name 字段
    }
    device.lastSeen = Date.now();
    device.requestCount++;
    
    // 记录城市（不限制数量）
    if (!device.cities[cityKey]) {
        device.cities[cityKey] = {
            city,
            name: city,  // 城市名称
            ip: clientIp,  // 记录首次访问的 IP
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            count: 0
        };
    }
    
    // 兼容旧数据：如果已存在的城市没有 IP 字段，补充当前 IP
    if (!device.cities[cityKey].ip) {
        device.cities[cityKey].ip = clientIp;
    }
    
    device.cities[cityKey].lastSeen = Date.now();
    device.cities[cityKey].count++;
    
    // 更新每日计数
    userData.stats.dailyCount++;
    
    // 注意：不在这里保存KV，由调用方统一保存
    // 这样避免重复保存，提高性能
    
    return {
        allowed: true,
        deviceId,
        city,
        deviceCount: currentDeviceCount,
        dailyCount: userData.stats.dailyCount
    };
}

const proxyClientKeywords = ['shadowrocket', 'quantumult', 'surge', 'loon', 'clash', 'openclash', 'stash', 'pharos', 
                             'v2rayn', 'v2rayng', 'kitsunebi', 'i2ray', 'pepi', 'potatso', 'netch',
                             'qv2ray', 'mellow', 'trojan', 'shadowsocks', 'surfboard', 'sing-box', 'singbox', 'nekobox'];

/**
 * 检测是否为浏览器访问
 * @param {string} userAgent - User-Agent字符串
 * @returns {boolean} - 是否为浏览器
 */
function isBrowserAccess(userAgent) {
    const browserKeywords = ['mozilla', 'chrome', 'safari', 'firefox', 'edge', 'opera', 'msie', 'trident'];
    
    const lowerUA = userAgent.toLowerCase();
    return browserKeywords.some(keyword => lowerUA.includes(keyword)) &&
           !proxyClientKeywords.some(keyword => lowerUA.includes(keyword));
}

function isSupportedProxyClient(userAgent) {
    const lowerUA = userAgent.toLowerCase();
    return proxyClientKeywords.some(keyword => lowerUA.includes(keyword));
}

/**
 * 返回浏览器访问的友好提示页面
 * @returns {Response} - HTML响应
 */
function getBrowserBlockedResponse() {
    const htmlResponse = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>订阅链接</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f5f5f7;
            color: #1d1d1f;
            line-height: 1.6;
        }
        
        .container {
            max-width: 980px;
            margin: 0 auto;
            padding: 60px 20px;
            text-align: center;
        }
        
        .icon {
            font-size: 5rem;
            margin-bottom: 2rem;
            display: inline-block;
        }
        
        h1 {
            font-size: 3.5rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            margin-bottom: 1rem;
            line-height: 1.1;
        }
        
        .subtitle {
            font-size: 1.3rem;
            color: #555;
            margin-bottom: 3rem;
            font-weight: 400;
            letter-spacing: -0.01em;
        }
        
        .content-section {
            background: white;
            border-radius: 18px;
            padding: 3rem 2rem;
            margin-bottom: 2rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        
        .content-section p {
            font-size: 1.1rem;
            color: #666;
            margin-bottom: 1.5rem;
            line-height: 1.8;
        }
        
        .guide-link {
            display: inline-block;
            padding: 12px 24px;
            background: #0071e3;
            color: white;
            text-decoration: none;
            border-radius: 980px;
            font-weight: 500;
            font-size: 1rem;
            transition: background 0.3s ease;
            margin-bottom: 2rem;
        }
        
        .guide-link:hover {
            background: #0077ed;
        }
        
        .guide-link:active {
            background: #0066cc;
        }
        
        .security-notice {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            border-radius: 12px;
            padding: 1.5rem;
            margin-top: 2rem;
            text-align: left;
            display: inline-block;
            max-width: 100%;
        }
        
        .security-notice strong {
            display: block;
            margin-bottom: 0.5rem;
            font-size: 1rem;
        }
        
        .security-notice p {
            color: #856404;
            font-size: 0.95rem;
            margin: 0;
        }
        
        @media (max-width: 768px) {
            h1 {
                font-size: 2.5rem;
            }
            
            .subtitle {
                font-size: 1.1rem;
            }
            
            .content-section {
                padding: 2rem 1.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">🔐</div>
        <h1>此链接仅供对应客户端使用</h1>
        <p class="subtitle">若不知道当前在做什么，关掉页面即可</p>
        
        <div class="content-section">
            <a href="https://mpin.tsmoe.com/r/mdviewer?file=fanqie-tutorial" class="guide-link" target="_blank">
                📖 查看参考指南
            </a>
            
            <div class="security-notice">
                <strong>⚠️ 安全提示</strong>
                <p>请勿在不安全的环境下打开此链接，避免在社交软件中分享泄露你的订阅。</p>
            </div>
        </div>
    </div>
</body>
</html>`;
    return new Response(htmlResponse, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

/**
 * 处理用户订阅请求（批量生成的三段式URL）
 * @param {string} userToken - 用户Token
 * @param {string} profileId - 订阅组ID
 * @param {string} profileToken - 订阅组Token
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} config - 配置对象
 * @param {Object} context - 上下文对象（包含waitUntil）
 * @returns {Promise<Response>} - 响应对象
 */
async function handleUserSubscription(userToken, profileId, profileToken, request, env, config, context) {
    try {
        const url = new URL(request.url);
        const adminKey = url.searchParams.get('admin_key');
        
        // 【安全检查】userToken 必须存在，或者提供有效的管理员 Key
        if (!userToken) {
            // 检查是否提供了管理员 Key
            if (!adminKey) {
                console.warn('[Security] Attempted access without userToken or admin_key');
                // 返回错误节点而不是 403，防止客户端使用缓存
                const errorNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('订阅链接异常')}`;
                const errorContent = [errorNode].join('\n');
                return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'no-store, no-cache'
                    }
                });
            }
            
            // 验证管理员 Key
            const storageAdapter = await getStorageAdapter(env);
            const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
            if (!settings.adminKey || adminKey !== settings.adminKey) {
                console.warn('[Security] Invalid admin_key provided');
                // 返回错误节点而不是 403，防止客户端使用缓存
                const errorNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('订阅链接异常')}`;
                const errorContent = [errorNode].join('\n');
                return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'no-store, no-cache'
                    }
                });
            }
            
            console.log('[Admin] Admin access granted for profile: ' + profileId);
        }
        
        // 【优先级0】订阅转换器回调请求处理（必须在所有检测之前）
        const callbackToken = await getCallbackToken(env);
        if (url.searchParams.get('callback_token') === callbackToken) {
            console.log('[Callback] Subconverter callback request, returning node list directly');
            
            // 加载用户数据
            const storageAdapter = await getStorageAdapter(env);
            const userDataRaw = await storageAdapter.get(`user:${userToken}`);
            if (!userDataRaw) {
                return new Response('User not found', { status: 404 });
            }
            
            const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
            
            // 加载订阅组配置
            const allProfiles = await storageAdapter.get(KV_KEY_PROFILES) || [];
            const profile = allProfiles.find(p => 
                (p.customId && p.customId === profileId) || p.id === profileId
            );
            
            if (!profile || !profile.enabled) {
                return new Response('Profile not found', { status: 404 });
            }
            
            const allMisubs = await storageAdapter.get(KV_KEY_SUBS) || [];
            const profileSubIds = new Set(profile.subscriptions);
            const profileNodeIds = new Set(profile.manualNodes);
            const targetMisubs = allMisubs.filter(item => {
                const isSubscription = item.url.startsWith('http');
                const isManualNode = !isSubscription;
                const belongsToProfile = (isSubscription && profileSubIds.has(item.id)) || 
                                        (isManualNode && profileNodeIds.has(item.id));
                return item.enabled && belongsToProfile;
            });
            
            // 生成节点列表
            const nodeLinks = await generateCombinedNodeList(
                { request, env },
                config,
                request.headers.get('User-Agent') || 'Unknown',
                targetMisubs,
                '',
                profile?.prefixSettings || null
            );
            
            // 调试日志
            const nodeCount = nodeLinks.split('\n').filter(line => line.trim()).length;
            console.log(`[Callback] Returning ${nodeCount} nodes to subconverter`);
            console.log(`[Callback] Node preview: ${nodeLinks.substring(0, 200)}`);
            
            // 返回base64编码的节点列表
            const base64Content = btoa(unescape(encodeURIComponent(nodeLinks)));
            return new Response(base64Content, {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache'
                }
            });
        }
        
        const asyncConfig = getConfig();
        
        // 0. 🔒 优先检测Bot请求（保护节点隐私）
        const userAgent = request.headers.get('User-Agent') || 'Unknown';
        let isBotRequest = false;
        if (asyncConfig.botDetection.ENABLED) {
            const botKeywords = asyncConfig.botDetection.BOT_KEYWORDS.join('|');
            const botPattern = new RegExp(botKeywords, 'i');
            isBotRequest = botPattern.test(userAgent);
        }
        
        if (isBotRequest) {
            // 🔒 拒绝所有Bot访问，防止节点信息泄露
            console.log(`🤖 Blocked bot/crawler request from: ${userAgent}`);
            return new Response('Access Denied: Bot requests are not allowed', { 
                status: 403,
                headers: { 'Content-Type': 'text/plain' }
            });
        }
        
        // 0.4 🎯 仅允许已知代理客户端访问（拦截脚本/未知 UA）
        if (!isBrowserAccess(userAgent) && !isSupportedProxyClient(userAgent)) {
            console.warn(`[Security] Blocked non-proxy client UA: ${userAgent}`);
            const errorNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('订阅链接异常')}`;
            const errorContent = [errorNode].join('\n');
            return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache'
                }
            });
        }
        
        // 0.5 🌐 检测浏览器访问（只允许代理客户端访问）
        if (isBrowserAccess(userAgent)) {
            console.log(`🌐 Blocked browser request from: ${userAgent}`);
            return getBrowserBlockedResponse();
        }
        
        // 1. 验证profileToken
        if (profileToken !== config.profileToken) {
            return new Response('Invalid Profile Token', { status: 403 });
        }
        
        // 2. 加载用户数据
        const storageAdapter = await getStorageAdapter(env);
        const userDataRaw = await storageAdapter.get(`user:${userToken}`);
        if (!userDataRaw) {
            return new Response('订阅链接无效或已被删除', { status: 404 });
        }
        
        const userData = typeof userDataRaw === 'string' ? JSON.parse(userDataRaw) : userDataRaw;
        
        // 3. 验证profileId匹配（支持 id 和 customId）
        // 加载所有 profiles 以获取 customId 信息
        const allProfilesForMatch = await storageAdapter.get(KV_KEY_PROFILES) || [];
        const targetProfile = allProfilesForMatch.find(p => p.id === userData.profileId);
        
        // 检查 URL 中的 profileId 是否匹配用户数据中的 profile.id 或其 customId
        const profileIdMatches = profileId === userData.profileId || 
                                (targetProfile && profileId === targetProfile.customId);
        
        if (!profileIdMatches) {
            return new Response('订阅组不匹配', { status: 403 });
        }

        // 3.1 🔧 加载订阅组配置（用于到期签名与反共享策略解析）
        const profile = allProfilesForMatch.find(p => 
            (p.customId && p.customId === profileId) || p.id === profileId
        );
        
        if (!profile || !profile.enabled) {
            return new Response('订阅组不存在或已禁用', { status: 403 });
        }
        
        // 4. 记录是否为首次激活
        const isFirstActivation = userData.status === 'pending';
        
        // 5. 首次激活处理
        if (isFirstActivation) {
            userData.status = 'activated';
            userData.activatedAt = Date.now();
            userData.expiresAt = Date.now() + userData.duration;
        }
        
        // 6. 检查是否过期
        const now = Date.now();
        let expiresAtTime = userData.expiresAt;
        
        // 处理 expiresAt 的格式（可能是字符串或时间戳）
        if (typeof userData.expiresAt === 'string') {
            expiresAtTime = new Date(userData.expiresAt).getTime();
        }
        
        console.log(`[UserSub] Expiry check - userToken: ${userToken}, expiresAt: ${userData.expiresAt}, expiresAtTime: ${expiresAtTime}, now: ${now}, isExpired: ${expiresAtTime && now > expiresAtTime}`);
        
        if (expiresAtTime && now > expiresAtTime) {
            console.log(`[UserSub] User ${userToken} subscription expired!`);
            const expiredNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('订阅已过期')}`;
            const noticeNodes = [
                `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('已失效请联系服务商')}`,
            ];

            // 按订阅组设置决定是否附加自定义到期签名节点
            if (profile && profile.expirySignatureEnabled && profile.expirySignatureText) {
                noticeNodes.push(
                    `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(profile.expirySignatureText)}`
                );
            }

            noticeNodes.push(
                `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('Token: ' + userToken)}`
            );
            
            const expiredContent = [expiredNode, ...noticeNodes].join('\n');
            return new Response(btoa(unescape(encodeURIComponent(expiredContent))), {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache',
                    'Subscription-UserInfo': `upload=0; download=0; total=0; expire=${Math.floor(expiresAtTime / 1000)}`
                }
            });
        }
        
        // 6.4 🎯 解析该分组和用户的反共享配置（按优先级合并）
        const effectiveAntiShareConfig = resolveAntiShareConfig(profile, userData, asyncConfig);
        console.log(`[AntiShare] Resolved config for profile ${profileId}, user ${userToken}:`, {
            profileName: profile.name,
            policyKey: profile.policyKey || '(none - using global default)',
            hasProfileOverrides: !!profile.antiShareOverrides,
            hasUserOverrides: !!userData.antiShareOverrides,
            MAX_DEVICES: effectiveAntiShareConfig.MAX_DEVICES,
            MAX_CITIES: effectiveAntiShareConfig.MAX_CITIES,
            CITY_CHECK_START_INDEX: effectiveAntiShareConfig.CITY_CHECK_START_INDEX,
            SUSPEND_DURATION_DAYS: effectiveAntiShareConfig.SUSPEND_DURATION_DAYS,
            SUSPEND_FAILED_ATTEMPTS_THRESHOLD: effectiveAntiShareConfig.SUSPEND_FAILED_ATTEMPTS_THRESHOLD,
            RATE_LIMITS: effectiveAntiShareConfig.RATE_LIMITS
        });
        
        if (!profile.policyKey && !profile.antiShareOverrides) {
            console.warn(`[AntiShare] ⚠️ Profile ${profileId} has no policyKey or overrides, using global default config`);
        }
        
        // 6.5 🛡️ 反共享检测（使用分组和用户的有效配置）
        const antiShareResult = await performAntiShareCheck(
            userToken,
            userData,
            request,
            env,
            { ...asyncConfig, antiShare: effectiveAntiShareConfig },  // 使用合并后的配置
            config,  // settings参数：包含 BotToken、ChatID 等
            context,
            profile  // 传入 profile 对象，用于检查是否在测试模式
        );
        
        if (!antiShareResult.allowed) {
            // 检测是否是Clash客户端
            const isClashClient = /clash|meta|mihomo/i.test(userAgent);
            
            let errorMessage = '';
            
            switch (antiShareResult.reason) {
                case 'suspended':
                    errorMessage = `account suspended - ${antiShareResult.suspendReason}`;
                    break;
                    
                case 'device_limit':
                    errorMessage = `reach device limit`;
                    break;
                    
                case 'new_device_new_city':
                    errorMessage = `new device new city - suspected sharing behavior`;
                    break;
                    
                case 'city_limit_exceeded':
                    errorMessage = `city limit exceeded - account reached ${antiShareResult.currentCityCount}/${antiShareResult.maxCities} cities`;
                    break;
                    
                case 'existing_device_new_city':
                    errorMessage = `city exception - this city is not a common city`;
                    break;
                    
                case 'rate_limit':
                    errorMessage = `rate limit - today has visited ${antiShareResult.dailyCount}/${antiShareResult.rateLimit} times`;
                    break;
            }
            
            // 🔧 对于需要完整配置文件的客户端，生成错误配置
            if (isClashClient) {
                console.log(`[AntiShare] Clash client detected, returning error proxy config`);
                
                // 保存userData的更改
                await storageAdapter.put(`user:${userToken}`, userData);
                console.log(`[AntiShare] Saved userData after rejection (failedAttempts: ${userData.stats.failedAttempts || 0}, suspended: ${!!userData.suspend})`);
                
                return generateErrorConfig('clash', errorMessage);
            }
            
            // 检测其他需要完整配置的客户端
            const isSurgeClient = /surge/i.test(userAgent);
            const isLoonClient = /loon/i.test(userAgent);
            
            if (isSurgeClient) {
                console.log(`[AntiShare] Surge client detected, returning error proxy config`);
                
                // 保存userData的更改
                await env.MISUB_KV.put(`user:${userToken}`, JSON.stringify(userData));
                console.log(`[AntiShare] Saved userData after rejection (failedAttempts: ${userData.stats.failedAttempts || 0}, suspended: ${!!userData.suspend})`);
                
                return generateErrorConfig('surge', errorMessage);
            }
            
            if (isLoonClient) {
                console.log(`[AntiShare] Loon client detected, returning error proxy config`);
                
                // 保存userData的更改
                await env.MISUB_KV.put(`user:${userToken}`, JSON.stringify(userData));
                console.log(`[AntiShare] Saved userData after rejection (failedAttempts: ${userData.stats.failedAttempts || 0}, suspended: ${!!userData.suspend})`);
                
                return generateErrorConfig('loon', errorMessage);
            }
            
            // 对于其他客户端（Shadowrocket/Loon），返回base64编码的错误文本
            let errorContent = '';
            
            switch (antiShareResult.reason) {
                case 'suspended':
                    errorContent = generateSuspendError(
                        antiShareResult.suspendUntil,
                        antiShareResult.suspendReason
                    );
                    break;
                    
                case 'device_limit':
                    errorContent = generateDeviceLimitError(
                        antiShareResult.deviceCount,
                        antiShareResult.maxDevices
                    );
                    break;
                    
                case 'new_device_new_city':
                    errorContent = generateNewDeviceNewCityError();
                    break;
                    
                case 'city_limit_exceeded':
                    errorContent = generateCityLimitError(
                        antiShareResult.currentCityCount,
                        antiShareResult.maxCities
                    );
                    break;
                    
                case 'existing_device_new_city':
                    errorContent = generateExistingDeviceNewCityError(
                        antiShareResult.deviceId,
                        antiShareResult.existingCities,
                        antiShareResult.city,
                        antiShareResult.cityCount,
                        antiShareResult.maxCities
                    );
                    break;
                    
                case 'rate_limit':
                    errorContent = generateRateLimitError(
                        antiShareResult.dailyCount,
                        antiShareResult.rateLimit,
                        antiShareResult.deviceCount
                    );
                    break;
            }
            
            // ⚠️ 重要：保存userData的更改（失败计数器、封禁状态等）
            // 即使请求被拒绝，也要保存这些统计信息
            await storageAdapter.put(`user:${userToken}`, userData);
            console.log(`[AntiShare] Saved userData after rejection (failedAttempts: ${userData.stats.failedAttempts || 0}, suspended: ${!!userData.suspend})`);
            
            return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
                status: 200,
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache'
                }
            });
        }
        
        // 7. 更新访问统计（暂不保存，等订阅内容成功生成后再保存）
        userData.stats.totalRequests = (userData.stats.totalRequests || 0) + 1;
        userData.stats.lastRequest = Date.now();
        // ⚠️ 注意：KV 保存已移到订阅内容成功生成之后，避免订阅转换器失败时设备配额被占用
        
        // 8. 发送Telegram通知
        // 【通知检查】检查是否应该发送激活/访问通知
        const telegramConfig = asyncConfig.telegram;
        const shouldDisableNotifications = !telegramConfig.GLOBAL_NOTIFY_ENABLED;
        const isTestMode = profile && profile.policyKey === 'basic' && telegramConfig.DISABLE_NOTIFY_IN_TEST_MODE;
        const shouldSendAccessNotifications = !shouldDisableNotifications && !isTestMode;
        
        if (config.BotToken && config.ChatID && shouldSendAccessNotifications) {
            const domain = new URL(request.url).hostname;
            const lastAccessTime = new Date(userData.stats.lastRequest).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const expiresTime = userData.expiresAt ? new Date(userData.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : 'N/A';
            const remarkLine = userData.remark ? `\n*备注:* \`${userData.remark}\`` : '';
            
            if (isFirstActivation) {
                // 首次激活：发送激活通知（包含所有信息）
                const activatedTime = new Date(userData.activatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                const additionalData = `*域名:* \`${domain}\`
*客户端:* \`${userAgent}\`
*Token:* \`${userToken}\`
*订阅组:* \`${profileId}\`
*总访问次数:* \`${userData.stats.totalRequests}\`
*激活时间:* \`${activatedTime}\`
*到期时间:* \`${expiresTime}\`${remarkLine}`;
                
                context.waitUntil(sendEnhancedTgNotification(config, '✅ *订阅已激活*', request, additionalData));
            } else {
                // 后续访问：发送访问通知
                const statusEmoji = '✅';
                const additionalData = `*域名:* \`${domain}\`
*客户端:* \`${userAgent}\`
*Token:* \`${userToken}\`
*订阅组:* \`${profileId}\`
*状态:* ${statusEmoji} \`${userData.status}\`
*总访问次数:* \`${userData.stats.totalRequests}\`
*上次访问:* \`${lastAccessTime}\`
*到期时间:* \`${expiresTime}\`${remarkLine}`;
                
                context.waitUntil(sendEnhancedTgNotification(config, '🛰️ *订阅被访问*', request, additionalData));
            }
        }
        
        // 8. 加载所有订阅和手动节点（profile已在反共享检测前加载）
        const allMisubs = await storageAdapter.get(KV_KEY_SUBS) || [];
        const profileSubIds = new Set(profile.subscriptions || []);
        const profileNodeIds = new Set(profile.manualNodes || []);
        
        const targetMisubs = allMisubs.filter(item => {
            const isSubscription = item.url.startsWith('http');
            const isManualNode = !isSubscription;
            const belongsToProfile = (isSubscription && profileSubIds.has(item.id)) || 
                                    (isManualNode && profileNodeIds.has(item.id));
            return item.enabled && belongsToProfile;
        });
        
        // 9. 获取订阅组的配置
        const effectiveSubConverter = profile.subConverter && profile.subConverter.trim() !== '' 
            ? profile.subConverter 
            : config.subConverter;
        const effectiveSubConfig = profile.subConfig && profile.subConfig.trim() !== '' 
            ? profile.subConfig 
            : config.subConfig;
        
        // 10. 生成订阅内容（使用现有逻辑）
        const nodeLinks = await generateCombinedNodeList(
            { request, env },
            config,
            userAgent,
            targetMisubs,
            '', // 不需要prepend内容
            profile?.prefixSettings || null
        );
        
        // 调试日志
        console.log(`[UserSub] userToken: ${userToken}, profileId: ${profileId}`);
        console.log(`[UserSub] targetMisubs count: ${targetMisubs.length}`);
        console.log(`[UserSub] nodeLinks length: ${nodeLinks?.length || 0}`);
        console.log(`[UserSub] nodeLinks preview: ${nodeLinks?.substring(0, 100)}`);
        
        // 11. 判断目标格式（复用公共函数，如果格式需要SubConfig但未配置则降级到base64）
        const targetFormat = determineTargetFormat(url, userAgent, effectiveSubConfig);
        
        // 12. 如果是base64格式，直接返回
        if (targetFormat === 'base64') {
            const base64Content = btoa(unescape(encodeURIComponent(nodeLinks)));
            
            // ✅ 订阅内容已成功生成，保存（包含设备绑定、访问统计等）
            await storageAdapter.put(`user:${userToken}`, userData);
            
            // 【修复】处理 expiresAt 格式（可能是字符串或时间戳）
            let expiresAtTimestamp = userData.expiresAt;
            if (typeof userData.expiresAt === 'string') {
                expiresAtTimestamp = new Date(userData.expiresAt).getTime();
            }
            
            // 【新增】获取总流量（从 profile.totalBandwidth 或使用默认值）
            const totalBandwidthBytes = parseBandwidthToBytes(profile.totalBandwidth);
            console.log(`[Base64] Profile totalBandwidth: "${profile.totalBandwidth}", Parsed bytes: ${totalBandwidthBytes}`);
            
            return new Response(base64Content, {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache',
                    'Subscription-UserInfo': `upload=0; download=0; total=${totalBandwidthBytes}; expire=${Math.floor(expiresAtTimestamp / 1000)}`,
                    'Profile-Update-Interval': '24',
                    'Profile-Title': profile.name || config.FileName
                }
            });
        }
        
        // 13. 其他格式：通过订阅转换器处理（复用公共函数）
        if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
            return new Response('Subconverter backend is not configured.', { status: 500 });
        }
        
        const callbackPath = `/${profileToken}/${profileId}/${userToken}`;
        
        // 【修复】处理 expiresAt 格式（可能是字符串或时间戳）
        let expiresAtTimestamp = userData.expiresAt;
        if (typeof userData.expiresAt === 'string') {
            expiresAtTimestamp = new Date(userData.expiresAt).getTime();
        }
        
        // 【新增】获取总流量（从 profile.totalBandwidth 或使用默认值）
        const totalBandwidthBytes = parseBandwidthToBytes(profile.totalBandwidth);
        console.log(`[Subconverter] Profile totalBandwidth: "${profile.totalBandwidth}", Parsed bytes: ${totalBandwidthBytes}`);
        
        const additionalHeaders = {
            'Subscription-UserInfo': `upload=0; download=0; total=${totalBandwidthBytes}; expire=${Math.floor(expiresAtTimestamp / 1000)}`,
            'Profile-Update-Interval': '24',
            'Profile-Title': profile.name || config.FileName
        };
        
        // 调用订阅转换器
        const subconverterResponse = await processViaSubconverter(
            nodeLinks,
            targetFormat,
            url,
            callbackPath,
            env,
            effectiveSubConverter,
            effectiveSubConfig,
            profile.name || config.FileName,
            additionalHeaders
        );
        
        // ✅ 只有订阅转换成功（2xx状态），才保存 KV
        if (subconverterResponse.ok) {
            await storageAdapter.put(`user:${userToken}`, userData);
            console.log(`[UserSub] ✅ Subscription converted successfully, saved for token: ${userToken}`);
        } else {
            console.warn(`[UserSub] ⚠️ Subscription conversion failed (${subconverterResponse.status}), KV NOT saved to prevent device quota waste`);
        }
        
        return subconverterResponse;
    } catch (error) {
        // 捕获所有错误并返回详细信息
        console.error(`[UserSub Error] ${error.message}`, error.stack);
        const errorNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('❌ 订阅处理错误')}`;
        const errorDetails = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('错误: ' + error.message)}`;
        const errorContent = [errorNode, errorDetails].join('\n');
        
        return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store, no-cache'
            }
        });
    }
}

// --- [核心修改] 订阅处理函数 ---
async function handleMisubRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    // 【优先级最高】检测订阅转换器请求（必须在浏览器检测之前）
    // 订阅转换器的UA通常是"Mozilla/5.0"，但有特征请求头
    const isSubconverterRequest = 
        request.headers.get('subconverter-request') === '1' ||
        request.headers.has('subconverter-version') ||
        url.searchParams.has('callback_token');
    
    if (isSubconverterRequest) {
        console.log(`[Subconverter] Detected subconverter request, bypassing browser check`);
    }
    
    // 🌐 检测浏览器访问（只允许代理客户端访问）
    // 但要排除订阅转换器的callback请求
    if (!isSubconverterRequest && isBrowserAccess(userAgentHeader)) {
        console.log(`🌐 Blocked browser request from: ${userAgentHeader}`);
        return getBrowserBlockedResponse();
    }

    const storageAdapter = await getStorageAdapter(env);
    const [settingsData, misubsData, profilesData] = await Promise.all([
        storageAdapter.get(KV_KEY_SETTINGS),
        storageAdapter.get(KV_KEY_SUBS),
        storageAdapter.get(KV_KEY_PROFILES)
    ]);
    const settings = settingsData || {};
    const allMisubs = misubsData || [];
    const allProfiles = profilesData || [];
    // 关键：我们在这里定义了 `config`，后续都应该使用它
    const config = migrateConfigSettings({ ...defaultSettings, ...settings }); 

    let token = '';
    let profileIdentifier = null;
    let userToken = null;  // 新增：用户Token（三段式URL）
    const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);

    if (pathSegments.length === 3) {
        // 三段式：/profileToken/profileId/userToken
        token = pathSegments[0];              // "publicshare"
        profileIdentifier = pathSegments[1];  // "gyshare"
        userToken = pathSegments[2];          // "a3f5d8e2"
    }
    else if (pathSegments.length === 2) {
        // 双段式：/profileToken/profileId（现有逻辑）
        token = pathSegments[0];
        profileIdentifier = pathSegments[1];
    }
    else if (pathSegments.length === 1) {
        // 单段式：/mytoken（现有逻辑）
        token = pathSegments[0];
    }
    else {
        // 查询参数（兜底）
        token = url.searchParams.get('token');
    }
    
    // 如果是三段式URL（用户订阅），使用专门的处理函数
    if (userToken) {
        return await handleUserSubscription(userToken, profileIdentifier, token, request, env, config, context);
    }

    let targetMisubs;
    let subName = config.FileName;
    let effectiveSubConverter;
    let effectiveSubConfig;
    let isProfileExpired = false; // Moved declaration here

    const DEFAULT_EXPIRED_NODE = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('您的订阅已失效')}`;
    const EXPIRED_NOTICE_NODES = [
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('获取新的节点')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('请在浏览器访问')}`,
        `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('1yo.cc')}`
    ];

    if (profileIdentifier) {

        // [修正] 使用 config 變量
        // 【安全检查】二段式 URL 只允许：1) 有效的管理员 Key 2) 有效的 callback_token（subconverter 回调）
        const adminKey = url.searchParams.get('admin_key');
        const callbackToken = url.searchParams.get('callback_token');
        const validCallbackToken = await getCallbackToken(env);
        
        const hasValidAdminKey = adminKey && adminKey === config.adminKey;
        const hasValidCallbackToken = callbackToken === validCallbackToken;
        
        console.log(`[Security] Two-segment URL check: profileIdentifier=${profileIdentifier}, hasValidAdminKey=${hasValidAdminKey}, hasValidCallbackToken=${hasValidCallbackToken}`);
        
        if (!hasValidAdminKey && !hasValidCallbackToken) {
            // 返回错误节点而不是 403，防止客户端使用缓存
            const errorNode = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('订阅链接异常')}`;
            const errorContent = [errorNode].join('\n');
            console.warn('[Security] Attempted access to profile without valid admin_key or callback_token');
            return new Response(btoa(unescape(encodeURIComponent(errorContent))), {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache'
                }
            });
        }
        
        const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
        if (profile && profile.enabled) {
            // Check if the profile has an expiration date and if it's expired

            if (profile.expiresAt) {
                const expiryDate = new Date(profile.expiresAt);
                const now = new Date();
                if (now > expiryDate) {
                    isProfileExpired = true;
                }
            }

            if (isProfileExpired) {
                subName = profile.name; // Still use profile name for filename
                targetMisubs = [
                    { id: 'expired-node', url: DEFAULT_EXPIRED_NODE, name: '您的订阅已到期', isExpiredNode: true },
                    { id: 'notice-node-1', url: EXPIRED_NOTICE_NODES[0], name: '获取新的节点', isExpiredNode: true },
                    { id: 'notice-node-2', url: EXPIRED_NOTICE_NODES[1], name: '请在浏览器访问', isExpiredNode: true },
                    { id: 'notice-node-3', url: EXPIRED_NOTICE_NODES[2], name: '1yo.cc', isExpiredNode: true }
                ]; // Set expired nodes with notice messages
            } else {
                subName = profile.name;
                const profileSubIds = new Set(profile.subscriptions);
                const profileNodeIds = new Set(profile.manualNodes);
                targetMisubs = allMisubs.filter(item => {
                    const isSubscription = item.url.startsWith('http');
                    const isManualNode = !isSubscription;

                    // Check if the item belongs to the current profile and is enabled
                    const belongsToProfile = (isSubscription && profileSubIds.has(item.id)) || (isManualNode && profileNodeIds.has(item.id));
                    if (!item.enabled || !belongsToProfile) {
                        return false;
                    }
                    return true;
                });
            }
            effectiveSubConverter = profile.subConverter && profile.subConverter.trim() !== '' ? profile.subConverter : config.subConverter;
            effectiveSubConfig = profile.subConfig && profile.subConfig.trim() !== '' ? profile.subConfig : config.subConfig;
        } else {
            return new Response('Profile not found or disabled', { status: 404 });
        }
    } else {
        // [修正] 使用 config 變量
        if (!token || token !== config.mytoken) {
            return new Response('Invalid Token', { status: 403 });
        }
        targetMisubs = allMisubs.filter(s => s.enabled);
        // [修正] 使用 config 變量
        effectiveSubConverter = config.subConverter;
        effectiveSubConfig = config.subConfig;
    }

    if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
        return new Response('Subconverter backend is not configured.', { status: 500 });
    }
    
    // 复用公共函数判断目标格式（如果格式需要SubConfig但未配置则降级到base64）
    const targetFormat = determineTargetFormat(url, userAgentHeader, effectiveSubConfig);

    if (!url.searchParams.has('callback_token')) {
        const clientIp = request.headers.get('CF-Connecting-IP') || 'N/A';
        const country = request.headers.get('CF-IPCountry') || 'N/A';
        const domain = url.hostname;
        
        let additionalData = `*域名:* \`${domain}\`\n*客户端:* \`${userAgentHeader}\`\n*请求格式:* \`${targetFormat}\``;
        
        let profileForNotification = null;
        if (profileIdentifier) {
            additionalData += `\n*订阅组:* \`${subName}\``;
            profileForNotification = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
            if (profileForNotification && profileForNotification.expiresAt) {
                const expiryDateStr = new Date(profileForNotification.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                additionalData += `\n*到期时间:* \`${expiryDateStr}\``;
            }
        }
        
        // 【通知检查】检查是否应该发送访问通知
        const asyncConfig = getConfig();
        const telegramConfig = asyncConfig.telegram;
        const shouldDisableNotifications = !telegramConfig.GLOBAL_NOTIFY_ENABLED;
        const isTestMode = profileForNotification && profileForNotification.policyKey === 'basic' && telegramConfig.DISABLE_NOTIFY_IN_TEST_MODE;
        const shouldSendAccessNotifications = !shouldDisableNotifications && !isTestMode;
        
        // 使用增强版TG通知，包含IP地理位置信息
        if (shouldSendAccessNotifications) {
            context.waitUntil(sendEnhancedTgNotification(config, '🛰️ *订阅被访问*', request, additionalData));
        }
    }

    let prependedContentForSubconverter = '';

    if (isProfileExpired) { // Use the flag set earlier
        prependedContentForSubconverter = ''; // Expired node is now in targetMisubs
    } else {
        // Otherwise, add traffic remaining info if applicable
        const totalRemainingBytes = targetMisubs.reduce((acc, sub) => {
            if (sub.enabled && sub.userInfo && sub.userInfo.total > 0) {
                const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
                const remaining = sub.userInfo.total - used;
                return acc + Math.max(0, remaining);
            }
            return acc;
        }, 0);
        if (totalRemainingBytes > 0) {
            const formattedTraffic = formatBytes(totalRemainingBytes);
            const fakeNodeName = `流量剩余 ≫ ${formattedTraffic}`;
            prependedContentForSubconverter = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(fakeNodeName)}`;
        }
    }

    const combinedNodeList = await generateCombinedNodeList(
        context, 
        config, 
        userAgentHeader, 
        targetMisubs, 
        prependedContentForSubconverter,
        profileIdentifier ? allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier)?.prefixSettings : null
    );

    // 如果是base64格式，直接返回
    if (targetFormat === 'base64') {
        let contentToEncode;
        if (isProfileExpired) {
            contentToEncode = DEFAULT_EXPIRED_NODE + '\n' + EXPIRED_NOTICE_NODES.join('\n') + '\n';
        } else {
            contentToEncode = combinedNodeList;
        }
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(btoa(unescape(encodeURIComponent(contentToEncode))), { headers });
    }

    // 其他格式：通过订阅转换器处理（复用公共函数）
    const callbackPath = profileIdentifier ? `/${token}/${profileIdentifier}` : `/${token}`;
    return await processViaSubconverter(
        combinedNodeList,
        targetFormat,
        url,
        callbackPath,
        env,
        effectiveSubConverter,
        effectiveSubConfig,
        subName
    );
}

async function getCallbackToken(env) {
    const secret = env.COOKIE_SECRET || 'default-callback-secret';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode('callback-static-data'));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}


// --- [核心修改] Cloudflare Pages Functions 主入口 ---
export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);

    // **核心修改：判斷是否為定時觸發**
    if (request.headers.get("cf-cron")) {
        return handleCronTrigger(env);
    }

    if (url.pathname.startsWith('/api/')) {
        const response = await handleApiRequest(request, env);
        return response;
    }
    const isStaticAsset = /^\/(assets|@vite|src)\/./.test(url.pathname) || /\.\w+$/.test(url.pathname);
    if (!isStaticAsset && url.pathname !== '/') {
        return handleMisubRequest(context);
    }
    return next();
}