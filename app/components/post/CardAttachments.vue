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

// Text opens in a floating window on the page (AttachmentWindow); a zip still
// downloads, since nothing here can list one and StaXX sends none.
function viewable(a: Attachment) {
  return a.contentType !== 'application/zip'
}

interface OpenWindow { a: Attachment, x: number, y: number, z: number }
const windows = ref<OpenWindow[]>([])
let topZ = 60 // above the fixed site header (z-50)

function focusWindow(w: OpenWindow) {
  if (w.z !== topZ) w.z = ++topZ
}

function openWindow(a: Attachment) {
  const already = windows.value.find(w => w.a.id === a.id)
  if (already) return focusWindow(already)
  // Each new window a step down and right of the last, so none hides another.
  const step = (windows.value.length % 6) * 28
  const width = Math.min(640, window.innerWidth - 16)
  windows.value.push({
    a,
    x: Math.max(8, (window.innerWidth - width) / 2) + step,
    y: 96 + step,
    z: ++topZ,
  })
}

function closeWindow(id: string) {
  windows.value = windows.value.filter(w => w.a.id !== id)
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
    closeWindow(a.id)
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
        <component
          :is="viewable(a) ? 'button' : 'a'"
          v-bind="viewable(a) ? { type: 'button', title: $t('attachments.open', { name: a.filename }) } : { href: href(a), download: a.filename }"
          class="flex-1 min-w-0 group text-left"
          @click="viewable(a) && openWindow(a)"
        >
          <p class="text-sm font-semibold truncate group-hover:text-primary transition-colors">{{ a.filename }}</p>
          <p class="text-[11px] text-muted-foreground truncate">
            {{ formatSize(a.size) }} · {{ $t('attachments.deletedOn', { date: formatDate(a.expiresAt) }) }}
          </p>
        </component>
        <a
          v-if="viewable(a)"
          :href="href(a)"
          :download="a.filename"
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          :title="$t('attachments.download')"
        >
          <Icon name="lucide:download" size="13" />
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
    <AttachmentWindow
      v-for="w in windows"
      :key="w.a.id"
      :url="href(w.a)"
      :filename="w.a.filename"
      :content-type="w.a.contentType"
      :size="formatSize(w.a.size)"
      :x="w.x"
      :y="w.y"
      :z="w.z"
      @focus="focusWindow(w)"
      @close="closeWindow(w.a.id)"
    />
  </div>
</template>
