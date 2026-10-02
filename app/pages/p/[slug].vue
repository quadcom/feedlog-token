<script setup lang="ts">
const route = useRoute()
const slug = route.params.slug as string
const localePath = useLocalePath()

const store = usePostDetailStore()
const boardStore = useBoardStore()

await callOnce(() => boardStore.fetchBoards())

// SSR: fetch via useFetch (payload auto-transferred), then hydrate store on both sides
const { data: postData } = await useFetch<PostDetail>(`/api/posts/${slug}`)
// A hidden card must look exactly like a missing one, so both go to the front page
if (!postData.value) {
  await navigateTo(localePath('/'), { redirectCode: 302 })
} else {
  store.setPost(slug, postData.value)
}

const postId = computed(() => postData.value?.id)
const { data: commentsData } = await useFetch<{ data: CommentItem[]; pagination: { nextCursor: string | null } }>(
  computed(() => `/api/posts/${postId.value}/comments`),
  { query: { sort: 'newest', withChildren: 'true', limit: 10 }, immediate: !!postId.value },
)
if (commentsData.value) {
  store.setComments(slug, commentsData.value.data, commentsData.value.pagination.nextCursor)
}

// Bind share-card meta directly to the SSR-fetched post (not the store) so the
// first SSR paint crawlers see has the real title/description, not "Loading…".
usePageOg({
  kind: 'post',
  title: () => postData.value?.title,
  content: () => postData.value?.content,
})
</script>

<template>
  <div class="flex-1 flex flex-col md:flex-row gap-8 min-w-0">
    <PostDetail :slug="slug" @deleted="navigateTo(localePath('/'))" />
  </div>
</template>
