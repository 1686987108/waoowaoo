import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { createProjectFromPanels } from '@/features/video-editor'

/**
 * POST /api/novel-promotion/[projectId]/editor/create
 * 从成片面板创建剪辑项目
 */
export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await params

  // 🔐 统一权限验证
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const { episodeId, panelIds } = body

  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 查找剧集下的所有面板
  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboard: {
        episodeId
      }
    },
    orderBy: {
      panelIndex: 'asc'
    },
    include: {
      storyboard: {
        select: {
          id: true
        }
      }
    }
  })

  if (panels.length === 0) {
    throw new ApiError('NO_PANELS_FOUND')
  }

  // 如果有指定的 panelIds，过滤；否则使用所有面板
  const targetPanels = panelIds
    ? panels.filter(p => panelIds.includes(p.id))
    : panels

  // 查找配音
  const voiceLines = await prisma.novelPromotionVoiceLine.findMany({
    where: {
      episodeId
    },
    orderBy: {
      createdAt: 'asc'
    }
  })

  // 使用工具函数创建项目
  const project = createProjectFromPanels(
    episodeId,
    targetPanels.map(p => ({
      id: p.id,
      panelIndex: p.panelIndex,
      storyboardId: p.storyboard.id,
      videoUrl: p.videoUrl || undefined,
      description: p.description || undefined,
      duration: p.duration || undefined
    })),
    voiceLines.length > 0 ? voiceLines.map(v => ({
      id: v.id,
      speaker: v.speaker || '',
      content: v.content || '',
      audioUrl: v.audioUrl || undefined
    })) : undefined
  )

  // 保存项目
  const savedProject = await prisma.videoEditorProject.upsert({
    where: { episodeId },
    create: {
      episodeId,
      projectData: JSON.stringify(project)
    },
    update: {
      projectData: JSON.stringify(project)
    }
  })

  return NextResponse.json({
    success: true,
    id: savedProject.id,
    episodeId: savedProject.episodeId,
    projectData: project,
    renderStatus: savedProject.renderStatus,
    outputUrl: savedProject.outputUrl,
    updatedAt: savedProject.updatedAt
  })
})
