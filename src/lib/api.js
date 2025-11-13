//
// src/lib/api.js
//
export async function fetchInitialData() {
    try {
        const response = await fetch('/api/data');
        if (!response.ok) {
            console.error("Session invalid or API error, status:", response.status);
            return null;
        }
        // 后端已经更新，会返回 { misubs, profiles, config }
        return await response.json();
    } catch (error) {
        console.error("Failed to fetch initial data:", error);
        return null;
    }
}

export async function login(password) {
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        return response;
    } catch (error) {
        console.error("Login request failed:", error);
        return { ok: false, error: '网络请求失败' };
    }
}

// [核心修改] saveMisubs 现在接收并发送 profiles
export async function saveMisubs(misubs, profiles) {
    try {
        // 数据预验证
        if (!Array.isArray(misubs) || !Array.isArray(profiles)) {
            return { success: false, message: '数据格式错误：misubs 和 profiles 必须是数组' };
        }

        const response = await fetch('/api/misubs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 将 misubs 和 profiles 一起发送
            body: JSON.stringify({ misubs, profiles })
        });

        // 检查HTTP状态码
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.message || errorData.error || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error('saveMisubs 网络请求失败:', error);

        // 根据错误类型返回更具体的错误信息
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            return { success: false, message: '网络连接失败，请检查网络连接' };
        } else if (error.name === 'SyntaxError') {
            return { success: false, message: '服务器响应格式错误' };
        } else {
            return { success: false, message: `网络请求失败: ${error.message}` };
        }
    }
}

export async function fetchNodeCount(subUrl) {
    try {
        const res = await fetch('/api/node_count', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: subUrl })
        });
        const data = await res.json();
        return data; // [修正] 直接返回整个对象 { count, userInfo }
    } catch (e) {
        console.error('fetchNodeCount error:', e);
        return { count: 0, userInfo: null };
    }
}

export async function fetchSettings() {
    try {
        const response = await fetch('/api/settings');
        if (!response.ok) return {};
        return await response.json();
    } catch (error) {
        console.error("Failed to fetch settings:", error);
        return {};
    }
}

export async function saveSettings(settings) {
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        // 检查HTTP状态码
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.message || errorData.error || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error('saveSettings 网络请求失败:', error);

        // 根据错误类型返回更具体的错误信息
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            return { success: false, message: '网络连接失败，请检查网络连接' };
        } else if (error.name === 'SyntaxError') {
            return { success: false, message: '服务器响应格式错误' };
        } else {
            return { success: false, message: `网络请求失败: ${error.message}` };
        }
    }
}

/**
 * 批量更新订阅的节点信息
 * @param {string[]} subscriptionIds - 要更新的订阅ID数组
 * @returns {Promise<Object>} - 更新结果
 */
export async function batchUpdateNodes(subscriptionIds) {
    try {
        const response = await fetch('/api/batch_update_nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptionIds })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.message || errorData.error || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        const result = await response.json();
        return result;
    } catch (error) {
        console.error("Failed to batch update nodes:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 数据迁移：从 KV 迁移到 D1 数据库
 * @returns {Promise<Object>} - 迁移结果
 */
export async function migrateToD1() {
    try {
        const response = await fetch('/api/migrate_to_d1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.message || errorData.error || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        const result = await response.json();
        return result;
    } catch (error) {
        console.error("Failed to migrate to D1:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 测试订阅链接内容
 * @param {string} url - 订阅URL
 * @param {string} userAgent - User-Agent
 * @returns {Promise<Object>} - 测试结果
 */
export async function testSubscription(url, userAgent) {
    try {
        const response = await fetch('/api/debug_subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, userAgent })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.message || errorData.error || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        const result = await response.json();
        return result;
    } catch (error) {
        console.error("Failed to test subscription:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

// ==================== 用户管理 API ====================

/**
 * 获取用户列表
 * @param {Object} filters - 过滤条件
 * @param {string} filters.profileId - 订阅组ID
 * @param {string} filters.status - 用户状态
 * @param {string} filters.search - 搜索关键词
 * @param {number} filters.page - 页码
 * @param {number} filters.pageSize - 每页数量
 * @returns {Promise<Object>} - 用户列表和分页信息
 */
export async function fetchUsers(filters = {}) {
    try {
        const params = new URLSearchParams({
            page: filters.page || 0,
            pageSize: filters.pageSize || 20,
            ...(filters.profileId && { profileId: filters.profileId }),
            ...(filters.status && { status: filters.status }),
            ...(filters.search && { search: filters.search })
        });

        const response = await fetch(`/api/users?${params}`);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || `服务器错误 (${response.status})`;
            return { success: false, error: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to fetch users:", error);
        return { success: false, error: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 获取用户详情
 * @param {string} token - 用户 Token
 * @returns {Promise<Object>} - 用户详细信息
 */
export async function fetchUserDetail(token) {
    try {
        const response = await fetch(`/api/users/${token}`);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || `服务器错误 (${response.status})`;
            return { success: false, error: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to fetch user detail:", error);
        return { success: false, error: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 解封用户
 * @param {string} token - 用户 Token
 * @returns {Promise<Object>} - 操作结果
 */
export async function unsuspendUser(token) {
    try {
        const response = await fetch(`/api/users/${token}/unsuspend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || errorData.message || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to unsuspend user:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 更新用户信息
 * @param {string} token - 用户 Token
 * @param {Object} updates - 要更新的字段
 * @param {string} updates.expiresAt - 到期时间
 * @param {string} updates.profileId - 订阅组ID
 * @param {string} updates.status - 状态
 * @returns {Promise<Object>} - 操作结果
 */
export async function updateUser(token, updates) {
    try {
        const response = await fetch(`/api/users/${token}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || errorData.message || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to update user:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 删除用户
 * @param {string} token - 用户 Token
 * @returns {Promise<Object>} - 操作结果
 */
export async function deleteUser(token) {
    try {
        const response = await fetch(`/api/users/${token}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || errorData.message || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to delete user:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}

/**
 * 批量删除用户
 * @param {Array<string>} tokens - 用户 Token 数组
 * @returns {Promise<Object>} - 操作结果
 */
export async function batchDeleteUsers(tokens) {
    try {
        const response = await fetch('/api/users/batch-delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ tokens })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error || errorData.message || `服务器错误 (${response.status})`;
            return { success: false, message: errorMessage };
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to batch delete users:", error);
        return { success: false, message: '网络请求失败，请检查网络连接' };
    }
}
