<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4" @click.self="emit('close')">
    <!-- 背景遮罩 -->
    <div class="fixed inset-0 bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75 transition-opacity" @click="emit('close')"></div>

    <!-- 弹窗内容 -->
    <div class="relative w-full max-w-4xl bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
      <div class="flex-1 overflow-y-auto p-4 sm:p-6">
        <!-- 加载状态 -->
        <div v-if="loading" class="flex justify-center py-12">
          <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>

        <!-- 错误状态 -->
        <div v-else-if="!userDetail" class="py-12 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 mx-auto text-red-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p class="text-gray-500 dark:text-gray-400 text-lg mb-4">加载用户详情失败</p>
          <div class="flex justify-center gap-4">
            <button @click="loadUserDetail" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors">
              重试
            </button>
            <button @click="emit('close')" class="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg transition-colors">
              关闭
            </button>
          </div>
        </div>

        <!-- 用户详情 -->
        <div v-else class="space-y-6">
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

          <!-- 用户备注 -->
          <div class="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
            <label class="block text-sm font-medium text-gray-900 dark:text-white mb-2">
              📝 用户备注
            </label>
            <div class="flex gap-2">
              <input
                v-model="editData.remark"
                @input="hasChanges = true"
                type="text"
                maxlength="50"
                placeholder="输入备注（最多50字符）"
                class="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
              >
              <span class="text-xs text-gray-500 dark:text-gray-400 self-center whitespace-nowrap">
                {{ (editData.remark || '').length }}/50
              </span>
            </div>
            
            <!-- 修改历史 -->
            <details v-if="userDetail.remarkHistory && userDetail.remarkHistory.length > 0" class="mt-3 text-xs">
              <summary class="cursor-pointer text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium">
                📋 修改历史 ({{ userDetail.remarkHistory.length }})
              </summary>
              <div class="mt-2 space-y-1 pl-4 border-l-2 border-blue-300 dark:border-blue-700">
                <div v-for="(history, idx) in userDetail.remarkHistory" :key="idx" class="text-gray-700 dark:text-gray-300">
                  <div class="font-mono text-xs">{{ history.content || '(无)' }}</div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">{{ formatDate(history.updatedAt) }}</div>
                </div>
              </div>
            </details>
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
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
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
            <div class="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-gray-600 dark:text-gray-400">今日访问次数</p>
                  <p class="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{{ userDetail.stats.dailyCount || 0 }}</p>
                </div>
                <button
                  @click="handleResetDailyCount"
                  :disabled="saving"
                  title="重置今日访问次数"
                  class="inline-flex items-center justify-center h-9 w-9 rounded-full border border-yellow-300 dark:border-yellow-700 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-900/30 transition-colors disabled:opacity-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
                  </svg>
                </button>
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
                      <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                    <tr v-for="device in sortedDevices" :key="device.id" class="hover:bg-gray-100 dark:hover:bg-gray-800">
                      <td class="px-4 py-2"><code class="text-xs">{{ device.id }}</code></td>
                      <td class="px-4 py-2 text-gray-900 dark:text-white">{{ device.name }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(device.activatedAt) }}</td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(device.lastSeen) }}</td>
                      <td class="px-4 py-2 text-right">
                        <button
                          class="inline-flex items-center px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/30 dark:hover:bg-red-900/50 rounded whitespace-nowrap"
                          @click="handleDeleteDevice(device.id)"
                        >
                          解绑设备
                        </button>
                      </td>
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
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">IP 地址</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">最后使用</th>
                      <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                    <tr v-for="city in sortedCities" :key="city.id" class="hover:bg-gray-100 dark:hover:bg-gray-800">
                      <td class="px-4 py-2"><code class="text-xs">{{ city.id }}</code></td>
                      <td class="px-4 py-2 text-gray-900 dark:text-white">{{ city.name }}</td>
                      <td class="px-4 py-2">
                        <code v-if="city.ip && city.ip !== 'Unknown'" class="text-xs text-blue-600 dark:text-blue-400">{{ city.ip }}</code>
                        <span v-else class="text-xs text-gray-400 dark:text-gray-500 italic">等待下次访问更新</span>
                      </td>
                      <td class="px-4 py-2 text-gray-600 dark:text-gray-400">{{ formatDate(city.lastSeen) }}</td>
                      <td class="px-4 py-2 text-right">
                        <button
                          class="inline-flex items-center px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/30 dark:hover:bg-red-900/50 rounded whitespace-nowrap"
                          @click="handleDeleteCity(city.id)"
                        >
                          删除城市
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <p v-else class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">暂无城市</p>
          </div>

        </div>
      </div>

      <!-- 底部固定操作栏 -->
      <div v-if="userDetail" class="flex-none p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-end gap-3">
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
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { fetchUserDetail, updateUser, unsuspendUser as apiUnsuspendUser, deleteUserDevice, deleteUserCity, resetUserDailyCount } from '../lib/api.js';
import { useToastStore } from '../stores/toast.js';

const props = defineProps({
  token: {
    type: String,
    required: true
  }
});

const emit = defineEmits(['close', 'updated']);
const { showToast } = useToastStore();

const show = ref(true);
const loading = ref(false);
const saving = ref(false);
const userDetail = ref(null);
const profiles = ref([]);
const hasChanges = ref(false);

// 按最后使用时间降序排列设备和城市
const sortedDevices = computed(() => {
  if (!userDetail.value?.devices) return [];
  return [...userDetail.value.devices].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
});
const sortedCities = computed(() => {
  if (!userDetail.value?.cities) return [];
  return [...userDetail.value.cities].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
});

const editData = ref({
  profileId: '',
  expiresAt: '',
  remark: ''
});

// 加载用户详情
async function loadUserDetail() {
  loading.value = true;
  userDetail.value = null; // 重置状态
  
  try {
    console.log('[UserDetail] 开始加载用户详情:', props.token);
    const result = await fetchUserDetail(props.token);
    console.log('[UserDetail] API 响应:', result);
    
    if (result.success) {
      userDetail.value = result.data;
      
      // 初始化编辑数据
      editData.value.profileId = result.data.profileId;
      editData.value.expiresAt = result.data.expiresAt ? formatDateForInput(result.data.expiresAt) : '';
      editData.value.remark = result.data.remark || '';
      
      console.log('[UserDetail] 用户详情加载成功');
    } else {
      console.error('[UserDetail] API 返回失败:', result.error);
      showToast('❌ ' + (result.error || '加载用户详情失败'), 'error');
    }
  } catch (error) {
    console.error('[UserDetail] 加载用户详情异常:', error);
    showToast('❌ 加载用户详情失败：' + error.message, 'error');
  } finally {
    loading.value = false;
  }
}

// 重置今日访问次数
async function handleResetDailyCount() {
  if (!confirm('确定要重置此用户的今日访问次数吗？')) return;

  const input = prompt('输入要重置的次数（留空=0）', '0');
  if (input === null) return;
  const trimmed = String(input).trim();
  const value = trimmed === '' ? 0 : Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    showToast('❌ 次数必须是非负整数', 'error');
    return;
  }

  saving.value = true;
  try {
    const result = await resetUserDailyCount(props.token, value);
    if (result.success) {
      showToast('✅ 今日访问次数已重置', 'success');
      emit('updated');
      await loadUserDetail();
    } else {
      showToast('❌ ' + (result.message || '重置失败'), 'error');
    }
  } catch (error) {
    console.error('Reset daily count error:', error);
    showToast('❌ 重置失败：' + error.message, 'error');
  } finally {
    saving.value = false;
  }
}

// 解绑设备
async function handleDeleteDevice(deviceId) {
  if (!deviceId) return;
  if (!confirm(`确定要解绑设备 ${deviceId} 吗？`)) return;

  saving.value = true;
  try {
    const result = await deleteUserDevice(props.token, deviceId);
    if (result.success) {
      showToast('✅ 设备已解绑', 'success');
      await loadUserDetail();
      emit('updated');
    } else {
      showToast('❌ ' + (result.message || '解绑设备失败'), 'error');
    }
  } catch (error) {
    console.error('Delete device error:', error);
    showToast('❌ 解绑设备失败：' + error.message, 'error');
  } finally {
    saving.value = false;
  }
}

// 删除城市记录
async function handleDeleteCity(cityId) {
  if (!cityId) return;
  if (!confirm(`确定要删除城市记录 ${cityId} 吗？`)) return;

  saving.value = true;
  try {
    const result = await deleteUserCity(props.token, cityId);
    if (result.success) {
      showToast('✅ 城市记录已删除', 'success');
      await loadUserDetail();
      emit('updated');
    } else {
      showToast('❌ ' + (result.message || '删除城市记录失败'), 'error');
    }
  } catch (error) {
    console.error('Delete city error:', error);
    showToast('❌ 删除城市记录失败：' + error.message, 'error');
  } finally {
    saving.value = false;
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
    
    if (editData.value.remark !== (userDetail.value.remark || '')) {
      updates.remark = editData.value.remark;
    }
    
    const result = await updateUser(props.token, updates);
    
    if (result.success) {
      showToast('✅ 用户信息已更新', 'success');
      hasChanges.value = false;
      emit('updated');
      await loadUserDetail();
    } else {
      showToast('❌ ' + (result.message || '更新失败'), 'error');
    }
  } catch (error) {
    console.error('Update user error:', error);
    showToast('❌ 更新失败：' + error.message, 'error');
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
      showToast('🔓 用户已解封', 'success');
      emit('updated');
      await loadUserDetail();
    } else {
      showToast('❌ ' + (result.message || '解封失败'), 'error');
    }
  } catch (error) {
    console.error('Unsuspend user error:', error);
    showToast('❌ 解封失败：' + error.message, 'error');
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
