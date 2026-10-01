// Board list item
export interface BoardItem {
  id: string
  name: string
  description: string | null
  position: number
  // 'staff' boards are visible to owners and managers only.
  visibility: 'public' | 'staff'
  postCount: number
  createdAt: string
}
