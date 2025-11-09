<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  show: Boolean,
  profile: Object
});

const emit = defineEmits(['close', 'generate']);

const count = ref(5);
const duration = ref(30);
const generating = ref(false);
const generatedTokens = ref([]);
const showResults = ref(false);

const profileName = computed(() => props.profile?.name || '');
const profileId = computed(() => props.profile?.customId || props.profile?.id || '');

const handleGenerate = async () => {
  generating.value = true;
  try {
    const response = await fetch('/api/batch-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        profileId: profileId.value,
        count: count.value,
        duration: duration.value
      })
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || '生成失败');
    }
    
    generatedTokens.value = result.tokens || [];
    showResults.value = true;
    
  } catch (error) {
    alert(`生成失败：${error.message}`);
  } finally {
    generating.value = false;
  }
};

const exportCSV = () => {
  const csv = [
    'Token,订阅链接,套餐,有效期,状态',
    ...generatedTokens.value.map(t => 
      `${t.token},${t.url},${profileName.value},${duration.value}天,未激活`
    )
  ].join('\n');
  
  downloadFile(csv, `tokens_${Date.now()}.csv`, 'text/csv');
};

const exportTXT = () => {
  const txt = generatedTokens.value.map(t => t.url).join('\n');
  downloadFile(txt, `links_${Date.now()}.txt`, 'text/plain');
};

const copyAll = () => {
  const text = generatedTokens.value.map(t => t.url).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    alert('已复制所有链接到剪贴板！');
  });
};

const copyLink = (url) => {
  navigator.clipboard.writeText(url).then(() => {
    alert('已复制到剪贴板！');
  });
};

const downloadFile = (content, filename, type) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const handleClose = () => {
  generatedTokens.value = [];
  showResults.value = false;
  count.value = 5;
  duration.value = 30;
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" @click.self="handleClose">
        <!-- 生成配置界面 -->
        <div v-if="!showResults" class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-6 smooth-all">
          <div class="flex items-center justify-between mb-6">
            <h3 class="text-xl font-bold text-gray-900 dark:text-white">批量生成订阅链接</h3>
            <button @click="handleClose" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="space-y-4">
            <div class="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-4">
              <p class="text-sm text-gray-600 dark:text-gray-300">
                <span class="font-semibold">订阅组：</span>{{ profileName }}
              </p>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                <span class="font-semibold">ID：</span>{{ profileId }}
              </p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                生成数量
              </label>
              <input
                v-model.number="count"
                type="number"
                min="1"
                max="1000"
                class="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:bg-gray-700 dark:text-white"
                placeholder="请输入生成数量"
              />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">建议：每次生成不超过100个</p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                有效期（天）
              </label>
              <input
                v-model.number="duration"
                type="number"
                min="1"
                max="3650"
                class="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:bg-gray-700 dark:text-white"
                placeholder="请输入有效期"
              />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">常用：1天测试、30天月付、365天年付</p>
            </div>
          </div>

          <div class="flex gap-3 mt-6">
            <button
              @click="handleGenerate"
              :disabled="generating"
              class="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ generating ? '生成中...' : '生成' }}
            </button>
            <button
              @click="handleClose"
              class="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              取消
            </button>
          </div>
        </div>

        <!-- 生成结果界面 -->
        <div v-else class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-4xl p-6 smooth-all max-h-[90vh] flex flex-col">
          <div class="flex items-center justify-between mb-6">
            <h3 class="text-xl font-bold text-gray-900 dark:text-white">
              生成成功（共 {{ generatedTokens.length }} 个）
            </h3>
            <button @click="handleClose" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="flex gap-2 mb-4">
            <button @click="exportCSV" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              导出CSV
            </button>
            <button @click="exportTXT" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              导出TXT
            </button>
            <button @click="copyAll" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              复制全部
            </button>
          </div>

          <div class="overflow-auto flex-1">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-700 sticky top-0">
                <tr>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-300">#</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-300">Token</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-300">订阅链接</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700 dark:text-gray-300">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, index) in generatedTokens" :key="item.token" class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-400">{{ index + 1 }}</td>
                  <td class="px-4 py-3">
                    <code class="text-sm bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">{{ item.token }}</code>
                  </td>
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-400 truncate max-w-md" :title="item.url">
                    {{ item.url }}
                  </td>
                  <td class="px-4 py-3">
                    <button @click="copyLink(item.url)" class="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium">
                      复制
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-6">
            <button @click="handleClose" class="w-full bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors">
              关闭
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
