<script setup lang="ts">
import { toast } from 'vue-sonner'

// /connect?code=XXXX-XXXX — where a person approves an app (StaXX, say) to post
// as them, and sees and ends the apps they have connected. The app side of the
// flow is docs/connect-an-app.md.
//
// Nothing secret passes through this page. The code only names a pending
// request; approving it lets the app collect its token straight from the
// server at its next poll.

const route = useRoute()
const { t, locale } = useI18n()
useHead({ title: () => t('connect.title') })

const { data: session } = useAuthSession()
const loginModal = useLoginModal()

// A guest identity is not someone who can vouch for an app.
const signedIn = computed(() => {
  const u = session.value?.user as { isAnonymous?: boolean | null } | undefined
  return !!u && !u.isAnonymous
})

interface PendingView {
  userCode: string
  app: string
  label: string
  createdAt: string
  expiresAt: string
}
interface ConnectionView {
  id: string
  app: string
  label: string
  status: 'connected' | 'revoked'
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

const codeInput = ref(typeof route.query.code === 'string' ? route.query.code : '')
const pending = ref<PendingView | null>(null)
const lookupError = ref<string | null>(null)
const looking = ref(false)
const deciding = ref(false)
const outcome = ref<'approved' | 'denied' | null>(null)
const outcomeApp = ref('')

const connections = ref<ConnectionView[]>([])
const listLoaded = ref(false)

function errorMessage(e: unknown): string {
  const err = e as { data?: { message?: string; data?: { code?: string } } }
  if (err?.data?.data?.code === 'CONNECT_CODE_NOT_FOUND') return t('connect.codeInvalid')
  return err?.data?.message || t('connect.genericError')
}

async function lookup() {
  lookupError.value = null
  pending.value = null
  outcome.value = null
  if (!codeInput.value.trim()) return
  looking.value = true
  try {
    pending.value = await $fetch<PendingView>('/api/connect/lookup', {
      method: 'POST',
      body: { code: codeInput.value },
    })
  }
  catch (e) {
    lookupError.value = errorMessage(e)
  }
  finally {
    looking.value = false
  }
}

async function decide(allow: boolean) {
  if (!pending.value) return
  deciding.value = true
  try {
    await $fetch(allow ? '/api/connect/approve' : '/api/connect/deny', {
      method: 'POST',
      body: { code: pending.value.userCode },
    })
    outcomeApp.value = pending.value.app
    outcome.value = allow ? 'approved' : 'denied'
    pending.value = null
    codeInput.value = ''
    // The code stays in the address bar otherwise, and a reload would ask again.
    if (import.meta.client && route.query.code) {
      await navigateTo({ path: route.path, query: {} }, { replace: true })
    }
    if (allow) setTimeout(() => { void loadConnections() }, 6000)
  }
  catch (e) {
    lookupError.value = errorMessage(e)
    pending.value = null
  }
  finally {
    deciding.value = false
  }
}

async function loadConnections() {
  try {
    const res = await $fetch<{ data: ConnectionView[] }>('/api/connect')
    connections.value = res.data
  }
  catch {
    connections.value = []
  }
  finally {
    listLoaded.value = true
  }
}

const { confirm } = useConfirmDialog()

async function disconnect(c: ConnectionView) {
  const ok = await confirm({
    title: t('connect.disconnectTitle', { app: c.app }),
    description: t('connect.disconnectDesc', { app: c.app, label: c.label }),
    confirmText: t('connect.disconnect'),
    variant: 'destructive',
  })
  if (!ok) return
  try {
    await $fetch(`/api/connect/${c.id}`, { method: 'DELETE' })
    toast.success(t('connect.disconnected', { app: c.app }))
    await loadConnections()
  }
  catch (e) {
    toast.error(errorMessage(e))
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Session arrives after mount on a cold load, and again after the login modal
// closes; whenever someone is signed in, catch up on the code and the list.
// Browser only: during server rendering $fetch does not carry the person's
// cookie, so the lookup would fail and render an error the browser then redoes.
watch(signedIn, (yes) => {
  if (!yes || import.meta.server) return
  if (codeInput.value && !pending.value && !outcome.value) void lookup()
  void loadConnections()
}, { immediate: true })

const activeConnections = computed(() => connections.value.filter(c => c.status === 'connected'))
const endedConnections = computed(() => connections.value.filter(c => c.status === 'revoked').slice(0, 10))
</script>

<template>
  <div class="max-w-xl mx-auto px-6 py-12 space-y-8">
    <div>
      <h1 class="font-heading text-2xl font-bold tracking-tight">{{ $t('connect.title') }}</h1>
      <p class="text-sm text-muted-foreground mt-1 leading-relaxed">{{ $t('connect.subtitle') }}</p>
    </div>

    <!-- Signed out -->
    <section v-if="!signedIn" class="rounded-xl border border-border bg-card p-6 text-center">
      <Icon name="lucide:plug" size="28" class="mx-auto text-muted-foreground" />
      <p class="text-sm mt-3 leading-relaxed">{{ $t('connect.signInFirst') }}</p>
      <button
        class="mt-5 h-10 px-5 rounded-lg bg-primary text-primary-foreground text-sm font-heading font-bold hover:opacity-90 transition-all inline-flex items-center gap-2"
        @click="loginModal.open()"
      >
        {{ $t('connect.signIn') }}
        <Icon name="lucide:arrow-right" size="14" />
      </button>
    </section>

    <template v-else>
      <!-- Done -->
      <section v-if="outcome" class="rounded-xl border border-border bg-card p-6 text-center">
        <Icon
          :name="outcome === 'approved' ? 'lucide:circle-check' : 'lucide:circle-x'"
          size="28"
          :class="outcome === 'approved' ? 'mx-auto text-green-600' : 'mx-auto text-muted-foreground'"
        />
        <p class="text-sm font-bold mt-3">
          {{ outcome === 'approved' ? $t('connect.approvedTitle', { app: outcomeApp }) : $t('connect.deniedTitle', { app: outcomeApp }) }}
        </p>
        <p class="text-xs text-muted-foreground mt-1 leading-relaxed">
          {{ outcome === 'approved' ? $t('connect.approvedHint', { app: outcomeApp }) : $t('connect.deniedHint') }}
        </p>
      </section>

      <!-- Confirm -->
      <section v-else-if="pending" class="rounded-xl border border-border bg-card overflow-hidden">
        <div class="p-6">
          <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ pending.userCode }}</p>
          <h2 class="font-heading text-lg font-bold mt-1">
            {{ $t('connect.confirmTitle', { app: pending.app, label: pending.label }) }}
          </h2>
          <p class="text-xs text-muted-foreground mt-1">
            {{ $t('connect.confirmAs', { name: session?.user?.name ?? '', email: session?.user?.email ?? '' }) }}
          </p>

          <p class="text-sm font-semibold mt-5">{{ $t('connect.mayTitle', { app: pending.app }) }}</p>
          <ul class="mt-2 space-y-1.5 text-sm">
            <li class="flex gap-2"><Icon name="lucide:check" size="14" class="mt-0.5 shrink-0 text-green-600" />{{ $t('connect.mayPost') }}</li>
            <li class="flex gap-2"><Icon name="lucide:check" size="14" class="mt-0.5 shrink-0 text-green-600" />{{ $t('connect.mayPictures') }}</li>
            <li class="flex gap-2"><Icon name="lucide:check" size="14" class="mt-0.5 shrink-0 text-green-600" />{{ $t('connect.mayComment') }}</li>
            <li class="flex gap-2"><Icon name="lucide:check" size="14" class="mt-0.5 shrink-0 text-green-600" />{{ $t('connect.mayRead') }}</li>
          </ul>
          <ul class="mt-3 space-y-1.5 text-sm text-muted-foreground">
            <li class="flex gap-2"><Icon name="lucide:x" size="14" class="mt-0.5 shrink-0" />{{ $t('connect.mayNotModerate') }}</li>
            <li class="flex gap-2"><Icon name="lucide:x" size="14" class="mt-0.5 shrink-0" />{{ $t('connect.mayNotAccount') }}</li>
          </ul>
          <p class="text-xs text-muted-foreground mt-4 leading-relaxed">{{ $t('connect.lasts') }}</p>

          <div class="mt-5 flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 leading-relaxed">
            <Icon name="lucide:alert-triangle" size="14" class="mt-0.5 shrink-0 text-amber-600" />
            <span>{{ $t('connect.warning', { app: pending.app }) }}</span>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button
            :disabled="deciding"
            class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors disabled:opacity-50"
            @click="decide(false)"
          >
            {{ $t('connect.deny') }}
          </button>
          <button
            :disabled="deciding"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all disabled:opacity-50"
            @click="decide(true)"
          >
            {{ $t('connect.allow') }}
          </button>
        </div>
      </section>

      <!-- Enter a code -->
      <section v-else class="rounded-xl border border-border bg-card p-6">
        <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground" for="connect-code">{{ $t('connect.codeLabel') }}</label>
        <form class="mt-2 flex gap-2" @submit.prevent="lookup">
          <input
            id="connect-code"
            v-model="codeInput"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('connect.codePlaceholder')"
            class="flex-1 h-10 px-3 rounded-lg border border-border bg-background text-sm font-mono uppercase tracking-widest focus:outline-none focus:border-primary transition-colors"
          >
          <button
            type="submit"
            :disabled="looking || !codeInput.trim()"
            class="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all disabled:opacity-40"
          >
            {{ $t('connect.continue') }}
          </button>
        </form>
        <p v-if="lookupError" class="mt-3 text-xs text-red-600 flex items-center gap-1.5">
          <Icon name="lucide:alert-circle" size="13" class="shrink-0" />{{ lookupError }}
        </p>
        <p v-else class="mt-2 text-[11px] text-muted-foreground">{{ $t('connect.codeHint') }}</p>
      </section>

      <!-- The person's own connections -->
      <section class="rounded-xl border border-border bg-card overflow-hidden">
        <div class="px-5 py-3 border-b border-border">
          <h3 class="font-heading font-bold text-sm">{{ $t('connect.yourApps') }}</h3>
        </div>
        <p v-if="!listLoaded" class="px-5 py-4 text-sm text-muted-foreground">{{ $t('connect.loading') }}</p>
        <p v-else-if="!activeConnections.length && !endedConnections.length" class="px-5 py-4 text-sm text-muted-foreground">
          {{ $t('connect.noApps') }}
        </p>
        <ul v-else class="divide-y divide-border">
          <li v-for="c in activeConnections" :key="c.id" class="px-5 py-3 flex items-center gap-3">
            <Icon name="lucide:plug" size="16" class="text-muted-foreground shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-bold truncate">{{ $t('connect.appOn', { app: c.app, label: c.label }) }}</p>
              <p class="text-[11px] text-muted-foreground truncate">
                {{ $t('connect.connectedOn', { date: formatDate(c.createdAt) }) }}
                · {{ c.lastUsedAt ? $t('connect.lastUsed', { date: formatDate(c.lastUsedAt) }) : $t('connect.neverUsed') }}
              </p>
            </div>
            <button
              class="h-8 px-3 rounded-md border border-border text-xs font-semibold text-red-600 hover:bg-secondary transition-colors"
              @click="disconnect(c)"
            >
              {{ $t('connect.disconnect') }}
            </button>
          </li>
          <li v-for="c in endedConnections" :key="c.id" class="px-5 py-3 flex items-center gap-3 opacity-60">
            <Icon name="lucide:unplug" size="16" class="text-muted-foreground shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate">{{ $t('connect.appOn', { app: c.app, label: c.label }) }}</p>
              <p class="text-[11px] text-muted-foreground truncate">{{ $t('connect.endedOn', { date: formatDate(c.revokedAt) }) }}</p>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
