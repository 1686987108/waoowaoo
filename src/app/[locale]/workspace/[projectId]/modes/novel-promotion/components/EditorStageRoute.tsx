'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { VideoEditorStage, VideoEditorProject } from '@/features/video-editor'
import { useWorkspaceProvider } from '../WorkspaceProvider'

interface VideoEditorStageRouteProps {
  onBack: () => void
}

export default function VideoEditorStageRoute({ onBack }: VideoEditorStageRouteProps) {
  const { projectId, episodeId } = useWorkspaceProvider()
  const router = useRouter()
  const [project, setProject] = useState<VideoEditorProject | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId || !episodeId) return

    const loadOrCreateProject = async () => {
      try {
        setLoading(true)
        // 1. 先尝试从 DB 加载已有项目
        const res = await fetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)
        if (!res.ok) {
          throw new Error('Failed to load editor project')
        }
        const data = await res.json()

        if (data.projectData) {
          // 已有项目，直接使用
          setProject(data.projectData)
          return
        }

        // 2. DB 无项目，自动从成片面板创建（导入所有视频+配音素材）
        const createRes = await fetch(`/api/novel-promotion/${projectId}/editor/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId }),
        })
        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => null)
          throw new Error(errData?.error?.message || 'Failed to import materials')
        }
        const createData = await createRes.json()
        setProject(createData.projectData)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadOrCreateProject()
  }, [projectId, episodeId])

  const handleBack = () => {
    if (onBack) {
      onBack()
    } else {
      router.push(`/workspace/${projectId}?stage=videos&episode=${episodeId}`)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-[var(--glass-text-secondary)]">加载中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-[var(--glass-tone-danger-fg)]">加载失败: {error}</div>
      </div>
    )
  }

  return (
    <VideoEditorStage
      projectId={projectId!}
      episodeId={episodeId!}
      initialProject={project}
      onBack={handleBack}
    />
  )
}
