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

    const loadProject = async () => {
      try {
        setLoading(true)
        const res = await fetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)
        if (!res.ok) {
          throw new Error('Failed to load editor project')
        }
        const data = await res.json()
        setProject(data.projectData)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadProject()
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
