<template>
  <div class="user-management p-4 sm:p-6 space-y-6">
    <!-- 页面标题 -->
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold text-gray-800 dark:text-white">用户管理</h2>
      <button
        @click="loadUsers"
        :disabled="loading"
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" :class="{ 'animate-spin': loading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        刷新
      </button>
    </div>

    <!-- 过滤器 -->
    <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <!-- 订阅组筛选 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">订阅组</label>
          <select
            v-model="filters.profileId"
            @change="handleFilterChange"
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value="">全部订阅组</option>
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </option>
          </select>
        </div>

        <!-- 状态筛选 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">状态</label>
          <select
            v-model="filters.status"
            @change="handleFilterChange"
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value="">全部状态</option>
            <option value="pending">待激活</option>
            <option value="activated">已激活</option>
          </select>
        </div>

        <!-- 搜索框 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">搜索 Token</label>
          <input
            v-model="filters.search"
            @input="handleSearchInput"
            type="text"
            placeholder="输入 Token 搜索..."
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
      </div>

      <!-- 统计信息 -->
      <div class="mt-4 flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
        <div>
          共 <span class="font-semibold text-indigo-600 dark:text-indigo-400">{{ pagination.total }}</span> 个用户
        </div>
        <div v-if="filters.profileId || filters.status || filters.search" class="flex items-center gap-2">
          <button @click="clearFilters" class="text-indigo-600 dark:text-indigo-400 hover:underline">
            清除筛选
          </button>
        </div>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
    </div>

    <!-- 用户列表 -->
    <div v-else-if="users.length > 0" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <!-- 桌面端表格 -->
      <div class="hidden md:block overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Token</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">订阅组</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">状态</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">设备</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">城市</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">激活时间</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">到期时间</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="user in users" :key="user.token" class="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <code class="text-sm font-mono text-gray-900 dark:text-white">{{ user.token }}</code>
                  <button @click="copyToClipboard(user.token)" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="复制">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="text-sm text-gray-900 dark:text-white">{{ user.profileName }}</span>
                <span v-if="user.customId" class="ml-2 text-xs text-gray-500 dark:text-gray-400">({{ user.customId }})</span>
              </td>
              <td class="px-4 py-3">
                <span v-if="user.isSuspended" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                  已封禁
                </span>
                <span v-else-if="user.status === 'activated'" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  已激活
                </span>
                <span v-else class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                  待激活
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="text-sm" :class="user.deviceCount >= user.deviceLimit ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'">
                  {{ user.deviceCount }} / {{ user.deviceLimit }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="text-sm" :class="user.cityCount >= user.cityLimit ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'">
                  {{ user.cityCount }} / {{ user.cityLimit }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="text-sm text-gray-600 dark:text-gray-400">
                  {{ formatDate(user.activatedAt) }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="text-sm" :class="isExpired(user.expiresAt) ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'">
                  {{ formatDate(user.expiresAt) }}
                </span>
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-2">
                  <button @click="viewUserDetail(user.token)" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300" title="查看详情">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </button>
                  <button v-if="user.isSuspended" @click="unsuspendUser(user.token)" class="text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300" title="解封">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <button @click="confirmDelete(user.token)" class="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300" title="删除">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 移动端卡片 -->
      <div class="md:hidden divide-y divide-gray-200 dark:divide-gray-700">
        <div v-for="user in users" :key="user.token" class="p-4 space-y-3">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <code class="text-sm font-mono text-gray-900 dark:text-white">{{ user.token }}</code>
                <button @click="copyToClipboard(user.token)" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
              <div class="text-sm text-gray-600 dark:text-gray-400">
                {{ user.profileName }}
                <span v-if="user.customId" class="text-xs">({{ user.customId }})</span>
              </div>
            </div>
            <span v-if="user.isSuspended" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
              已封禁
            </span>
            <span v-else-if="user.status === 'activated'" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              已激活
            </span>
            <span v-else class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
              待激活
            </span>
          </div>
          
          <div class="text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div>设备: {{ user.deviceCount }} / {{ user.deviceLimit }}</div>
            <div>城市: {{ user.cityCount }} / {{ user.cityLimit }}</div>
            <div>激活: {{ formatDate(user.activatedAt) }}</div>
            <div :class="isExpired(user.expiresAt) ? 'text-red-600 dark:text-red-400 font-medium' : ''">
              到期: {{ formatDate(user.expiresAt) }}
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 pt-2">
            <button @click="viewUserDetail(user.token)" class="px-3 py-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-md transition-colors">
              详情
            </button>
            <button v-if="user.isSuspended" @click="unsuspendUser(user.token)" class="px-3 py-1.5 text-sm text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-md transition-colors">
              解封
            </button>
            <button @click="confirmDelete(user.token)" class="px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors">
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-12 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 mx-auto text-gray-400 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
      <p class="text-gray-500 dark:text-gray-400 text-lg">{{ filters.profileId || filters.status || filters.search ? '没有找到符合条件的用户' : '暂无用户数据' }}</p>
    </div>

    <!-- 分页 -->
    <div v-if="!loading && pagination.totalPages > 1" class="flex items-center justify-between bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
      <div class="text-sm text-gray-600 dark:text-gray-400">
        第 {{ pagination.page + 1 }} 页，共 {{ pagination.totalPages }} 页
      </div>
      <div class="flex items-center gap-2">
        <button
          @click="goToPage(pagination.page - 1)"
          :disabled="pagination.page === 0"
          class="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          上一页
        </button>
        <button
          @click="goToPage(pagination.page + 1)"
          :disabled="pagination.page >= pagination.totalPages - 1"
          class="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          下一页
        </button>
      </div>
    </div>

    <!-- 用户详情弹窗 -->
    <UserDetailModal
      v-if="selectedUser"
      :token="selectedUser"
      @close="selectedUser = null"
      @updated="loadUsers"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { fetchUsers as apiFetchUsers, unsuspendUser as apiUnsuspendUser, deleteUser as apiDeleteUser } from '../lib/api.js';
import { useToastStore } from '../stores/toast.js';
import UserDetailModal from './UserDetailModal.vue';

const { showToast } = useToastStore();

const users = ref([]);
const profiles = ref([]);
const loading = ref(false);
const selectedUser = ref(null);

const filters = ref({
  profileId: '',
  status: '',
  search: '',
  page: 0,
  pageSize: 20
});

const pagination = ref({
  page: 0,
  pageSize: 20,
  total: 0,
  totalPages: 0
});

// 加载用户列表
async function loadUsers() {
  loading.value = true;
  try {
    const result = await apiFetchUsers(filters.value);
    
    if (result.success) {
      users.value = result.data;
      pagination.value = result.pagination;
    } else {
      showToast(result.error || '加载用户列表失败', 'error');
    }
  } catch (error) {
    console.error('Load users error:', error);
    showToast('加载用户列表失败', 'error');
  } finally {
    loading.value = false;
  }
}

// 加载订阅组列表（用于过滤器）
async function loadProfiles() {
  try {
    const response = await fetch('/api/data');
    const data = await response.json();
    profiles.value = data.profiles || [];
  } catch (error) {
    console.error('Load profiles error:', error);
  }
}

// 过滤器变化处理
function handleFilterChange() {
  filters.value.page = 0;
  loadUsers();
}

// 搜索输入处理（防抖）
let searchTimeout = null;
function handleSearchInput() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    filters.value.page = 0;
    loadUsers();
  }, 500);
}

// 清除筛选
function clearFilters() {
  filters.value = {
    profileId: '',
    status: '',
    search: '',
    page: 0,
    pageSize: 20
  };
  loadUsers();
}

// 翻页
function goToPage(page) {
  if (page >= 0 && page < pagination.value.totalPages) {
    filters.value.page = page;
    loadUsers();
  }
}

// 查看用户详情
function viewUserDetail(token) {
  selectedUser.value = token;
}

// 解封用户
async function unsuspendUser(token) {
  if (!confirm('确定要解封此用户吗？')) return;
  
  try {
    const result = await apiUnsuspendUser(token);
    if (result.success) {
      showToast('🔓 用户已解封', 'success');
      await loadUsers();
    } else {
      showToast('❌ ' + (result.message || '解封失败'), 'error');
    }
  } catch (error) {
    console.error('Unsuspend user error:', error);
    showToast('❌ 解封失败：' + error.message, 'error');
  }
}

// 确认删除
function confirmDelete(token) {
  if (confirm('确定要删除此用户吗？此操作不可逆！')) {
    deleteUserData(token);
  }
}

// 删除用户
async function deleteUserData(token) {
  try {
    const result = await apiDeleteUser(token);
    if (result.success) {
      // 立即从界面移除该用户
      users.value = users.value.filter(u => u.token !== token);
      // 更新总数
      pagination.value.total--;
      // 显示成功提示
      showToast('✅ 用户已删除', 'success');
      // 重新加载以更新分页
      await loadUsers();
    } else {
      showToast('❌ ' + (result.message || '删除失败'), 'error');
    }
  } catch (error) {
    console.error('Delete user error:', error);
    showToast('❌ 删除失败：' + error.message, 'error');
  }
}

// 复制到剪贴板（兼容移动端，特别优化 iOS Safari）
async function copyToClipboard(text) {
  try {
    // 方案1：优先使用现代 Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('📋 已复制到剪贴板', 'success');
        return;
      } catch (clipboardError) {
        console.log('Clipboard API 失败，尝试降级方案:', clipboardError);
      }
    }
    
    // 方案2：iOS Safari 兼容的 execCommand 方案
    const textArea = document.createElement('textarea');
    textArea.value = text;
    
    // iOS Safari 需要 textarea 在视口内但不可见
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    textArea.setAttribute('readonly', '');
    
    document.body.appendChild(textArea);
    
    // iOS Safari 特殊处理
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      const range = document.createRange();
      range.selectNodeContents(textArea);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      textArea.setSelectionRange(0, text.length);
    } else {
      textArea.select();
    }
    
    let successful = false;
    try {
      successful = document.execCommand('copy');
    } catch (err) {
      console.error('execCommand 失败:', err);
    }
    
    document.body.removeChild(textArea);
    
    if (successful) {
      showToast('📋 已复制到剪贴板', 'success');
    } else {
      showToast('❌ 复制失败，请手动复制', 'error');
      console.error('Copy failed: execCommand returned false');
    }
  } catch (error) {
    console.error('Copy error:', error);
    showToast('❌ 复制失败：' + error.message, 'error');
  }
}

// 格式化日期
function formatDate(dateString) {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '-';
  }
}

// 检查是否过期
function isExpired(dateString) {
  if (!dateString) return false;
  return new Date(dateString) < new Date();
}

// 页面加载时初始化
onMounted(() => {
  loadProfiles();
  loadUsers();
});
</script>

<style scoped>
/* 自定义样式 */
.user-management {
  max-width: 1400px;
  margin: 0 auto;
}

/* 确保表格在小屏幕上可滚动 */
@media (max-width: 768px) {
  .user-management {
    padding: 1rem;
  }
}
</style>
