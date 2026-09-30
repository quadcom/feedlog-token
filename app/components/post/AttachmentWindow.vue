<script setup lang="ts">
// A floating, draggable, collapsible window showing one private card file as
// text (local/PLAN-attachment-viewer.md). Staff read a diagnostic log beside the
// card instead of downloading it.
//
// Plain text only, and that is the safety of it: the file is someone else's log
// and may hold anything, markup included. It is fetched through the same private
// endpoint (same author-or-staff check) and put on the page by interpolation,
// which Vue escapes, so nothing in it can render or run. Never v-html here.

const props = defineProps<{
  url: string
  filename: string
  contentType: string
  size: string
  x: number
  y: number
  z: number
}>()
const emit = defineEmits<{ close: [], focus: [] }>()
const { t } = useI18n()

const text = ref<string | null>(null)
const failed = ref(false)
const collapsed = ref(false)
const wrap = ref(true)

onMounted(async () => {
  try {
    const raw = await $fetch<string>(props.url, { responseType: 'text' })
    text.value = props.contentType === 'application/json' ? prettyJson(raw) : raw
  }
  catch {
    failed.value = true
  }
})

// Shown as sent when it does not parse: a broken JSON file is itself a clue.
function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2) }
  catch { return raw }
}

const root = ref<HTMLElement>()
const pos = reactive({ x: props.x, y: props.y })

// Kept on screen: the whole window across when it fits, and the title bar
// always reachable down the page, or a window dragged off an edge is lost.
function clamp() {
  const el = root.value
  if (!el) return
  const maxX = Math.max(0, window.innerWidth - el.offsetWidth)
  const maxY = Math.max(0, window.innerHeight - 40)
  pos.x = Math.min(Math.max(0, pos.x), maxX)
  pos.y = Math.min(Math.max(0, pos.y), maxY)
}
// A window collapsed and parked at the foot of the screen would otherwise
// expand downwards, off it. Lift it just enough to show whole, where it fits.
watch(collapsed, async (now) => {
  if (now) return
  await nextTick()
  const el = root.value
  if (el) pos.y = Math.max(0, Math.min(pos.y, window.innerHeight - el.offsetHeight))
})

onMounted(() => {
  clamp()
  window.addEventListener('resize', clamp)
})
onBeforeUnmount(() => window.removeEventListener('resize', clamp))

let drag: { dx: number, dy: number } | null = null

function onPointerDown(e: PointerEvent) {
  emit('focus')
  // The title bar's buttons must still click, not start a drag.
  if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return
  e.preventDefault()
  drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return
  pos.x = e.clientX - drag.dx
  pos.y = e.clientY - drag.dy
  clamp()
}
function onPointerUp() {
  drag = null
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      role="dialog"
      :aria-label="filename"
      class="fixed flex flex-col rounded-lg border border-border bg-card text-card-foreground shadow-2xl overflow-hidden"
      :class="{ 'w-72': collapsed }"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, zIndex: z }"
      @pointerdown="emit('focus')"
    >
      <div
        class="flex items-center gap-2 h-10 pl-3 pr-1 bg-secondary/60 border-b border-border cursor-move select-none touch-none"
        @pointerdown.stop="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="collapsed = !collapsed"
      >
        <Icon name="lucide:file-text" size="14" class="text-muted-foreground shrink-0" />
        <p class="flex-1 min-w-0 text-sm font-semibold truncate">{{ filename }}</p>
        <span class="text-[11px] text-muted-foreground shrink-0 hidden sm:inline">{{ size }}</span>
        <button
          v-show="!collapsed"
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center hover:bg-secondary transition-colors"
          :class="wrap ? 'text-primary' : 'text-muted-foreground'"
          :title="t('attachments.wrap')"
          :aria-pressed="wrap"
          @click="wrap = !wrap"
        >
          <Icon name="lucide:wrap-text" size="14" />
        </button>
        <a
          :href="url"
          :download="filename"
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          :title="t('attachments.download')"
        >
          <Icon name="lucide:download" size="14" />
        </a>
        <button
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          :title="collapsed ? t('attachments.expand') : t('attachments.collapse')"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <Icon :name="collapsed ? 'lucide:chevron-down' : 'lucide:chevron-up'" size="14" />
        </button>
        <button
          class="w-7 h-7 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          :title="t('attachments.close')"
          @click="emit('close')"
        >
          <Icon name="lucide:x" size="14" />
        </button>
      </div>
      <!-- v-show, not v-if: collapsing keeps whatever size the reader dragged the
           corner to, and the text is not fetched again on expand. -->
      <div
        v-show="!collapsed"
        class="attachment-window-body overflow-auto bg-background"
      >
        <p v-if="failed" class="p-4 text-sm text-red-600">{{ t('attachments.loadFailed') }}</p>
        <p v-else-if="text === null" class="p-4 text-sm text-muted-foreground">{{ t('attachments.loading') }}</p>
        <pre
          v-else
          class="p-3 text-xs leading-relaxed font-mono"
          :class="wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
        >{{ text }}</pre>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.attachment-window-body {
  resize: both;
  width: min(640px, calc(100vw - 16px));
  height: min(420px, 60vh);
  min-width: 260px;
  min-height: 120px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 56px);
}
</style>
