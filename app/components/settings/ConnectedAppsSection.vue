<script setup lang="ts">
import { toast } from 'vue-sonner'

// Members page → Connected apps (managers and owners). Every app connection in
// the workspace, grouped by person, with the tools to cut them off: one
// connection, all of a person's apps, every session they have, or a ban.
// See docs/connect-an-app.md.
//
// Its own section rather than extra items on the member rows: most people who
// connect an app are board users, not workspace members, so they are not in the
// members list at all.

const { t, locale } = useI18n()
const ctx = useOrgContext()
const { data: session } = useAuthSession()
const myUserId = computed(() => session.value?.user?.id)
const iAmOwner = computed(() => ctx.value.role === 'owner')

interface Person {
  id: string
  name: string
  email: string
  image: string | null
  banned: boolean
  role: string | null
}
interface Connection {
  id: string
  app: string
  label: string
  status: 'connected' | 'revoked'
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  person: Person
}
interface BannedPerson {
  id: string
  name: string
  email: string
  image: string | null
  banReason: string | null
  banExpires: string | null
}

const connections = ref<Connection[]>([])
const banned = ref<BannedPerson[]>([])
const loaded = ref(false)

async function refresh() {
  try {
    const res = await $fetch<{ data: Connection[]; banned: BannedPerson[] }>('/api/admin/connections')
    connections.value = res.data
    banned.value = res.banned
  }
  catch {
    connections.value = []
    banned.value = []
  }
  finally {
    loaded.value = true
  }
}
onMounted(() => { void refresh() })

// People with at least one live connection, each with theirs; people whose
// connections have all ended drop off (they are either reconnected or banned).
const people = computed(() => {
  const byId = new Map<string, { person: Person; items: Connection[] }>()
  for (const c of connections.value) {
    if (c.status !== 'connected') continue
    const entry = byId.get(c.person.id) ?? { person: c.person, items: [] }
    entry.items.push(c)
    byId.set(c.person.id, entry)
  }
  return [...byId.values()]
})

function canActOn(p: { id: string; role?: string | null }): boolean {
  if (p.id === myUserId.value) return false
  if (p.role === 'owner' && !iAmOwner.value) return false
  return true
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
}

function errorMessage(e: unknown): string {
  return (e as { data?: { message?: string } })?.data?.message || t('connect.genericError')
}

const { confirm } = useConfirmDialog()

async function run(
  opts: { title: string; description: string; confirmText: string },
  request: () => Promise<unknown>,
  done: string,
) {
  const ok = await confirm({ ...opts, variant: 'destructive' })
  if (!ok) return
  try {
    await request()
    toast.success(done)
    await refresh()
  }
  catch (e) {
    toast.error(errorMessage(e))
  }
}

function disconnectOne(c: Connection) {
  void run(
    {
      title: t('connect.admin.disconnectOneTitle'),
      description: t('connect.admin.disconnectOneDesc', { app: c.app, label: c.label, name: c.person.name }),
      confirmText: t('connect.disconnect'),
    },
    () => $fetch(`/api/admin/connections/${c.id}`, { method: 'DELETE' }),
    t('connect.admin.done'),
  )
}

function disconnectAll(p: Person) {
  void run(
    {
      title: t('connect.admin.disconnectAllTitle', { name: p.name }),
      description: t('connect.admin.disconnectAllDesc', { name: p.name }),
      confirmText: t('connect.admin.disconnectAll'),
    },
    () => $fetch(`/api/admin/people/${p.id}/disconnect-apps`, { method: 'POST' }),
    t('connect.admin.done'),
  )
}

function signOutEverywhere(p: Person) {
  void run(
    {
      title: t('connect.admin.signOutTitle', { name: p.name }),
      description: t('connect.admin.signOutDesc', { name: p.name }),
      confirmText: t('connect.admin.signOut'),
    },
    () => $fetch(`/api/admin/people/${p.id}/sign-out`, { method: 'POST' }),
    t('connect.admin.done'),
  )
}

function unban(p: { id: string; name: string }) {
  void run(
    {
      title: t('connect.admin.unbanTitle', { name: p.name }),
      description: t('connect.admin.unbanDesc', { name: p.name }),
      confirmText: t('connect.admin.unban'),
    },
    () => $fetch(`/api/admin/people/${p.id}/unban`, { method: 'POST' }),
    t('connect.admin.done'),
  )
}

// Ban needs a reason and a length, so it has its own dialog.
const banTarget = ref<Person | null>(null)
const banReason = ref('')
const banDays = ref<string>('forever')
const banning = ref(false)
const banOpen = computed({
  get: () => !!banTarget.value,
  set: (v: boolean) => { if (!v) banTarget.value = null },
})
const banLengths = computed(() => [
  { value: '1', label: t('connect.admin.banDay') },
  { value: '7', label: t('connect.admin.banWeek') },
  { value: '30', label: t('connect.admin.banMonth') },
  { value: 'forever', label: t('connect.admin.banForever') },
])

function openBan(p: Person) {
  banTarget.value = p
  banReason.value = ''
  banDays.value = 'forever'
}

async function confirmBan() {
  if (!banTarget.value) return
  banning.value = true
  try {
    await $fetch(`/api/admin/people/${banTarget.value.id}/ban`, {
      method: 'POST',
      body: {
        reason: banReason.value.trim() || undefined,
        expiresInDays: banDays.value === 'forever' ? null : Number(banDays.value),
      },
    })
    toast.success(t('connect.admin.banned', { name: banTarget.value.name }))
    banTarget.value = null
    await refresh()
  }
  catch (e) {
    toast.error(errorMessage(e))
  }
  finally {
    banning.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card overflow-hidden">
    <div class="px-5 py-3 border-b border-border">
      <h3 class="font-heading font-bold text-sm">{{ $t('connect.admin.title') }}</h3>
      <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('connect.admin.desc') }}</p>
    </div>

    <p v-if="!loaded" class="px-5 py-4 text-sm text-muted-foreground">{{ $t('connect.loading') }}</p>
    <p v-else-if="!people.length" class="px-5 py-4 text-sm text-muted-foreground">{{ $t('connect.admin.empty') }}</p>

    <ul v-else class="divide-y divide-border">
      <li v-for="entry in people" :key="entry.person.id" class="px-5 py-3">
        <div class="flex items-center gap-3">
          <UserAvatar :author="{ id: entry.person.id, name: entry.person.name, image: entry.person.image }" :size="9" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold truncate">{{ entry.person.name }}</p>
            <p class="text-[11px] text-muted-foreground truncate">{{ entry.person.email }}</p>
          </div>
          <DropdownMenu v-if="canActOn(entry.person)">
            <DropdownMenuTrigger as-child>
              <button class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground" :aria-label="$t('connect.admin.actions')">
                <Icon name="lucide:more-horizontal" size="14" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-[220px]">
              <DropdownMenuItem @click="disconnectAll(entry.person)">
                <Icon name="lucide:unplug" size="13" class="mr-2" />
                {{ $t('connect.admin.disconnectAll') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="signOutEverywhere(entry.person)">
                <Icon name="lucide:log-out" size="13" class="mr-2" />
                {{ $t('connect.admin.signOut') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="text-red-600" @click="openBan(entry.person)">
                <Icon name="lucide:ban" size="13" class="mr-2" />
                {{ $t('connect.admin.ban') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ul class="mt-2 ml-12 space-y-1">
          <li v-for="c in entry.items" :key="c.id" class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Icon name="lucide:plug" size="12" class="shrink-0" />
            <span class="flex-1 min-w-0 truncate">
              <span class="font-semibold text-foreground">{{ $t('connect.appOn', { app: c.app, label: c.label }) }}</span>
              · {{ $t('connect.connectedOn', { date: formatDate(c.createdAt) }) }}
              · {{ c.lastUsedAt ? $t('connect.lastUsed', { date: formatDate(c.lastUsedAt) }) : $t('connect.neverUsed') }}
            </span>
            <button
              v-if="canActOn(entry.person)"
              class="h-6 px-2 rounded border border-border font-semibold text-red-600 hover:bg-secondary transition-colors"
              @click="disconnectOne(c)"
            >
              {{ $t('connect.disconnect') }}
            </button>
          </li>
        </ul>
      </li>
    </ul>

    <template v-if="banned.length">
      <div class="px-5 py-3 border-t border-border">
        <h4 class="font-heading font-bold text-xs">{{ $t('connect.admin.bannedTitle') }}</h4>
      </div>
      <ul class="divide-y divide-border">
        <li v-for="b in banned" :key="b.id" class="px-5 py-3 flex items-center gap-3">
          <UserAvatar :author="{ id: b.id, name: b.name, image: b.image }" :size="9" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold truncate">{{ b.name }}</p>
            <p class="text-[11px] text-muted-foreground truncate">
              {{ b.email }}
              · {{ b.banExpires ? $t('connect.admin.bannedUntil', { date: formatDate(b.banExpires) }) : $t('connect.admin.bannedForever') }}
              <template v-if="b.banReason"> · {{ b.banReason }}</template>
            </p>
          </div>
          <button
            v-if="b.id !== myUserId"
            class="h-8 px-3 rounded-md border border-border text-xs font-semibold hover:bg-secondary transition-colors"
            @click="unban(b)"
          >
            {{ $t('connect.admin.unban') }}
          </button>
        </li>
      </ul>
    </template>

    <Dialog v-model:open="banOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="font-heading">{{ $t('connect.admin.banTitle', { name: banTarget?.name ?? '' }) }}</DialogTitle>
          <DialogDescription class="text-sm">{{ $t('connect.admin.banDesc') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground" for="ban-reason">{{ $t('connect.admin.banReason') }}</label>
            <input
              id="ban-reason"
              v-model="banReason"
              maxlength="200"
              :disabled="banning"
              :placeholder="$t('connect.admin.banReasonPlaceholder')"
              class="mt-2 w-full h-10 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
            >
          </div>
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('connect.admin.banLength') }}</label>
            <Select v-model="banDays" :disabled="banning">
              <SelectTrigger class="mt-2 w-full h-10 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in banLengths" :key="l.value" :value="l.value">{{ l.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <button class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors" @click="banTarget = null">
            {{ $t('common.cancel') }}
          </button>
          <button
            :disabled="banning"
            class="h-9 px-4 rounded-lg bg-red-600 text-white text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 transition-all"
            @click="confirmBan"
          >
            {{ $t('connect.admin.ban') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
