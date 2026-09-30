<script setup lang="ts">
import { toast } from 'vue-sonner'

// A card's private files (local/PLAN-private-attachments.md): diagnostic bundles
// an app such as StaXX attached. Mounted only for the card's author and
// managers/owners; the server enforces the same rule and answers anyone else
// with 404, so this never shows on the public card. Renders nothing when the
// card has none.

const props = defineProps<{ postId: string }>()
const { t, locale } = useI18n()

interface Attachment {
  id: string
  filename: string
  contentType: string
  size: number
  createdAt: string
  expiresAt: string
}

const items = ref<Attachment[]>([])

async function load() {
  try {
    const res = await $fetch<{ data: Attachment[] }>(`/api/posts/${props.postId}/attachments`)
    items.value = res.data
  }
  catch {
    items.value = []
  }
}
onMounted(() => { void load() })
watch(() => props.postId, () => { void load() })

function href(a: Attachment) {
  return `/api/posts/${props.postId}/attachments/${a.id}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
}

const { confirm } = useConfirmDialog()

async function remove(a: Attachment) {
  const ok = await confirm({
    title: t('attachments.deleteTitle'),
    description: t('attachments.deleteDesc', { name: a.filename }),
    confirmText: t('attachments.delete'),
    variant: 'destructive',
  })
  if (!ok) return
  try {
    await $fetch(href(a), { method: 'DELETE' })
    await load()
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } })?.data?.message || t('attachments.deleteFailed'))
  }
}
</script>

<template>
  <div v-if="items.length">
    <h4 class="font-heading text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
      <Icon name="lucide:lock" size="11" />
      {{ $t('attachments.title') }}
    </h4>
    <p class="text-[11px] text-muted-foreground mb-3 leading-relaxed">{{ $t('attachments.hint') }}</p>
    <ul class="space-y-2">
      <li v-for="a in items" :key="a.id" class="flex items-center gap-2">
        <Icon :name="a.contentType === 'application/zip' ? 'lucide:file-archive' : 'lucide:file-text'" size="16" class="text-muted-foreground shrink-0" />
        <a :href="href(a)" :download="a.filename" class="flex-1 min-w-0 group">
          <p class="text-sm font-semibold truncate group-hover:text-primary transition-colors">{{ a.filename }}</p>
          <p class="text-[11px] text-muted-foreground truncate">
            {{ formatSize(a.size) }} · {{ $t('attachments.deletedOn', { date: formatDate(a.expiresAt) }) }}
          </p>
        </a>
        <button
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-red-600 hover:bg-secondary/50 transition-colors"
          :title="$t('attachments.delete')"
          @click="remove(a)"
        >
          <Icon name="lucide:trash-2" size="13" />
        </button>
      </li>
    </ul>
  </div>
</template>
