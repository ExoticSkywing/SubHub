<template>
  <div v-if="show" class="fixed inset-0 z-50 overflow-y-auto" @click.self="emit('close')">
    <div class="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
      <!-- 背景遮罩 -->
      <div class="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75" @click="emit('close')"></div>

      <!-- 弹窗内容 -->
      <div class="relative inline-block w-full max-w-4xl px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white dark:bg-gray-800 rounded-lg shadow-xl sm:my-8 sm:align-middle sm:p-6">
        <!-- 加载状态 -->
        <div v-if="loading" class="flex justify-center py-12">
          <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>

        <!-- 用户详情 -->
        <div v-else-if="userDetail" class="space-y-6">
          <!-- 标题和关闭按钮 -->
          <div class="flex items-start justify-between">
            <div>
              <h3 class="text-2xl font-bold text-gray-900 dark:text-white">用户详情</h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Token: <code class="font-mono">{{ token }}</code></p>
            </div>
            <button @click="emit('close')" class="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 基本信息 -->
          <div class="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 space-y-3">
            <h4 class="font-semibold text-gray-900 dark:text-white mb-3">基本信息</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="text-sm text-gray-500 dark:text-gray-400">订阅组</label>
                <div class="mt-1 flex items-center gap-2">
                  <select
                    v-model="editData.profileId"
                    @change="hasChanges = true"
                    class="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  >
                    <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
                      {{ profile.name }}
                    </option>
                  </select>
                </div>
              </div>
              <div>
                <label class="text-sm text-gray-500 dark:text-gray-400">状态</label>
                <div class="mt-1">
                  <span v-if="userDetail.suspend" class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                    已封禁
                  </span>
                  <span v-else-if="userDetail.status === 'activated'" class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    已激活
                  </span>
                  <span v-else class="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                    待激活
                  </span>
                </div>
              </div>
              <div>
                <label class="text-sm text-gray-500 dark:text-gray-400">激活时间</label>
                <p class="mt-1 text-sm text-gray-900 dark:text-white">{{ formatDate(userDetail.activatedAt) }}</p>
              </div>
              <div>
                <label class="text-sm text-gray-500 dark:text-gray-400">到期时间</label>
                <div class="mt-1 flex items-center gap-2">
                  <input
                    v-model="editData.expiresAt"
                    @change="hasChanges = true"
                    type="datetime-local"
                    class="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                  />
                </div>
              </div>
            </div>

            <!-- 封禁信息 -->
            <div v-if="userDetail.suspend" class="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
              <div class="flex items-start gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div class="flex-1">
                  <p class="text-sm font-medium text-red-800 dark:text-red-200">封禁原因</p>
                  <p class="mt-1 text-sm text-red-700 dark:text-red-300">{{ userDetail.suspend.reason }}</p>
                  <p class="mt-1 text-xs text-red-600 dark:text-red-400">封禁时间: {{ formatDate(userDetail.suspend.timestamp) }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 统计信息 -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-gray-600 dark:text-gray-400">总请求数</p>
                  <p class="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{{ userDetail.stats.totalRequests || 0 }}</p>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
            </div>
            <div class="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-gray-600 dark:text-gray-400">设备数</p>
                  <p class="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{{ userDetail.devices.length }}</p>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
            </div>
            <div class="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-gray-600 dark:text-gray-400">城市数</p>
                  <p class="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{{ userDetail.cities.length }}</p>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
            </div>
          </div>

          <!-- 设备列表 -->
          <div>
            <h4 class="font-semibold text-gray-900 dark:text-white mb-3">设备列表</h4>
            <div v-if="userDetail.devices.length > 0" class="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-100 dark:bg-gray-800">
                    <tr>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">设备ID</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">设备名称</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">激活时间</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">最后使用</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                    <tr v-for="device in userDetail.devices" :key="device.id" class="hover:bg-gray-100 dark:hover:bg-gray-800">
                      <td class="px-4 py-2"><code class="text-xs">{{ device.id }}</code></td>
                      <td class="px-4 py-2 text-gray-900 dark:text-white">{{ device.name }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(device.activatedAt) }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(device.lastSeen) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p v-else class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">暂无设备</p>
          </div>

          <!-- 城市列表 -->
          <div>
            <h4 class="font-semibold text-gray-900 dark:text-white mb-3">城市列表</h4>
            <div v-if="userDetail.cities.length > 0" class="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-100 dark:bg-gray-800">
                    <tr>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">城市ID</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">城市名称</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">激活时间</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">最后使用</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                    <tr v-for="city in userDetail.cities" :key="city.id" class="hover:bg-gray-100 dark:hover:bg-gray-800">
                      <td class="px-4 py-2"><code class="text-xs">{{ city.id }}</code></td>
                      <td class="px-4 py-2 text-gray-900 dark:text-white">{{ city.name }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(city.activatedAt) }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(city.lastSeen) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p v-else class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">暂无城市</p>
          </div>

          <!-- 操作按钮 -->
          <div class="flex items-center justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              v-if="userDetail.suspend"
              @click="handleUnsuspend"
              :disabled="saving"
              class="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
            >
              解封用户
            </button>
            <button
              v-if="hasChanges"
              @click="handleSave"
              :disabled="saving"
              class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {{ saving ? '保存中...' : '保存修改' }}
            </button>
            <button
              @click="emit('close')"
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 rounded-lg transition-colors"
            >
              关闭
            </button>
          </div>
        </div>

        <!-- 错误状态 -->
        <div v-else class="text-center py-12">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 mx-auto text-red-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-gray-500 dark:text-gray-400">加载用户详情失败</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { fetchUserDetail, updateUser, unsuspendUser as apiUnsuspendUser } from '../lib/api.js';
import { useToastStore } from '../stores/toast.js';

const props = defineProps({
  token: {
    type: String,
    required: true
  }
});

const emit = defineEmits(['close', 'updated']);
const showToast = useToastStore().show;

const show = ref(true);
const loading = ref(false);
const saving = ref(false);
const userDetail = ref(null);
const profiles = ref([]);
const hasChanges = ref(false);

const editData = ref({
  profileId: '',
  expiresAt: ''
});

// 加载用户详情
async function loadUserDetail() {
  loading.value = true;
  try {
    const result = await fetchUserDetail(props.token);
    
    if (result.success) {
      userDetail.value = result.data;
      
      // 初始化编辑数据
      editData.value.profileId = result.data.profileId;
      editData.value.expiresAt = result.data.expiresAt ? formatDateForInput(result.data.expiresAt) : '';
    } else {
      showToast(result.error || '加载用户详情失败', 'error');
    }
  } catch (error) {
    console.error('Load user detail error:', error);
    showToast('加载用户详情失败', 'error');
  } finally {
    loading.value = false;
  }
}

// 加载订阅组列表
async function loadProfiles() {
  try {
    const response = await fetch('/api/data');
    const data = await response.json();
    profiles.value = data.profiles || [];
  } catch (error) {
    console.error('Load profiles error:', error);
  }
}

// 保存修改
async function handleSave() {
  saving.value = true;
  try {
    const updates = {};
    
    if (editData.value.profileId !== userDetail.value.profileId) {
      updates.profileId = editData.value.profileId;
    }
    
    if (editData.value.expiresAt) {
      updates.expiresAt = new Date(editData.value.expiresAt).toISOString();
    }
    
    const result = await updateUser(props.token, updates);
    
    if (result.success) {
      showToast('用户信息已更新', 'success');
      hasChanges.value = false;
      emit('updated');
      await loadUserDetail();
    } else {
      showToast(result.message || '更新失败', 'error');
    }
  } catch (error) {
    console.error('Update user error:', error);
    showToast('更新失败', 'error');
  } finally {
    saving.value = false;
  }
}

// 解封用户
async function handleUnsuspend() {
  if (!confirm('确定要解封此用户吗？')) return;
  
  saving.value = true;
  try {
    const result = await apiUnsuspendUser(props.token);
    
    if (result.success) {
      showToast('用户已解封', 'success');
      emit('updated');
      await loadUserDetail();
    } else {
      showToast(result.message || '解封失败', 'error');
    }
  } catch (error) {
    console.error('Unsuspend user error:', error);
    showToast('解封失败', 'error');
  } finally {
    saving.value = false;
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

// 格式化日期为输入框格式
function formatDateForInput(dateString) {
  if (!dateString) return '';
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  } catch {
    return '';
  }
}

// 初始化
onMounted(() => {
  loadProfiles();
  loadUserDetail();
});
</script>

<style scoped>
/* 弹窗动画 */
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.fixed {
  animation: fadeIn 0.2s ease-out;
}
</style>
