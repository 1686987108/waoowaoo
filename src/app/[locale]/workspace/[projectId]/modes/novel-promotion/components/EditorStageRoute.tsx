'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { VideoEditorStage, VideoEditorProject } from '@/features/video-editor'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { AppIcon } from '@/components/ui/icons'

interface VideoEditorStageRouteProps {
  onBack: () => void
}

type ImportStatus = 'loading' | 'success' | 'error'

export default function VideoEditorStageRoute({ onBack }: VideoEditorStageRouteProps) {
  const { projectId, episodeId } = useWorkspaceProvider()
  const router = useRouter()
  const [project, setProject] = useState<VideoEditorProject | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importStatus, setImportStatus] = useState<ImportStatus>('loading')
  const [importProgress, setImportProgress] = useState({ total: 0, withVideo: 0, withVoice: 0 })

  useEffect(() => {
    if (!projectId || !episodeId) return

    const loadOrCreateProject = async () => {
      try {
        setLoading(true)
        setImportStatus('loading')
        
        // 1. 先尝试从 DB 加载已有项目
        const res = await fetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)
        if (!res.ok) {
          throw new Error('Failed to load editor project')
        }
        const data = await res.json()

        if (data.projectData) {
          // 已有项目，直接使用
          setProject(data.projectData)
          setImportStatus('success')
          setImportProgress({
            total: data.projectData.timeline.length,
            withVideo: data.projectData.timeline.length,
            withVoice: data.projectData.timeline.filter((c: any) => c.attachment?.audio).length
          })
          return
        }

        // 2. DB 无项目，自动从成片面板创建（导入所有视频+配音素材）
        setImportStatus('loading')
        
        const createRes = await fetch(`/api/novel-promotion/${projectId}/editor/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId }),
        })
        
        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => null)
          throw new Error(errData?.error?.message || errData?.error?.details || 'Failed to import materials')
        }
        
        const createData = await createRes.json()
        setProject(createData.projectData)
        setImportStatus('success')
        setImportProgress({
          total: createData.importedPanels || createData.projectData.timeline.length,
          withVideo: createData.projectData.timeline.length,
          withVoice: createData.hasVoiceLines ? createData.projectData.timeline.filter((c: any) => c.attachment?.audio).length : 0
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
        setImportStatus('error')
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

  if (loading || importStatus === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
        <div className="relative">
          <AppIcon name="loader" className="w-12 h-12 animate-spin text-[var(--glass-tone-info-fg)]" />
        </div>
        <div className="text-center">
          <div className="text-lg font-medium text-[var(--glass-text-primary)] mb-2">
            正在导入成片素材...
          </div>
          <div className="text-sm text-[var(--glass-text-secondary)]">
            {importProgress.total > 0 ? (
              <>
                已导入 <span className="text-[var(--glass-tone-success-fg)] font-medium">{importProgress.withVideo}</span> 个视频片段
                {importProgress.withVoice > 0 && (
                  <>，<span className="text-[var(--glass-tone-info-fg)] font-medium">{importProgress.withVoice}</span> 条配音</>
                )}
              </>
            ) : (
              '正在分析成片数据...'
            )}
          </div>
        </div>
      </div>
    )
  }

  if (error || importStatus === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
        <AppIcon name="alertCircle" className="w-16 h-16 text-[var(--glass-tone-danger-fg)]" />
        <div className="text-center">
          <div className="text-lg font-medium text-[var(--glass-tone-danger-fg)] mb-2">
            导入失败
          </div>
          <div className="text-sm text-[var(--glass-text-secondary)] mb-4">
            {error || '未知错误'}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="glass-btn-base glass-btn-primary px-6 py-2"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
        <AppIcon name="videoOff" className="w-16 h-16 text-[var(--glass-text-tertiary)]" />
        <div className="text-center">
          <div className="text-lg font-medium text-[var(--glass-text-primary)] mb-2">
            暂无成片素材
          </div>
          <div className="text-sm text-[var(--glass-text-secondary)] mb-4">
            请先在成片阶段生成视频
          </div>
          <button
            onClick={handleBack}
            className="glass-btn-base glass-btn-secondary px-6 py-2"
          >
            返回成片
          </button>
        </div>
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
