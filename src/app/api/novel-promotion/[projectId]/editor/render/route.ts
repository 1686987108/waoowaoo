import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { renderMedia, Composition } from '@remotion/renderer'
import { VideoComposition } from '@/features/video-editor/remotion/VideoComposition'
import { getSignedUrl } from '@/lib/cos'
import { logInfo, logError as _ulogError } from '@/lib/logging/core'

/**
 * POST /api/novel-promotion/[projectId]/editor/render
 * 使用 Remotion 渲染剪辑项目为 MP4
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
  const { editorProjectId, format = 'mp4' } = body

  if (!editorProjectId) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 获取编辑器项目
  const editorProject = await prisma.videoEditorProject.findUnique({
    where: { id: editorProjectId }
  })

  if (!editorProject) {
    throw new ApiError('NOT_FOUND')
  }

  // 更新渲染状态为 pending
  await prisma.videoEditorProject.update({
    where: { id: editorProjectId },
    data: {
      renderStatus: 'pending',
      updatedAt: new Date()
    }
  })

  try {
    const projectData = JSON.parse(editorProject.projectData) as {
      id: string
      episodeId: string
      schemaVersion: string
      config: { fps: number; width: number; height: number }
      timeline: Array<{
        id: string
        src: string
        durationInFrames: number
        trim?: { from: number; to: number }
        attachment?: { audio?: { src: string; volume: number } }
        transition?: { type: string; durationInFrames: number }
        metadata: { panelId: string; storyboardId: string; description?: string }
      }>
      bgmTrack: Array<{
        id: string
        src: string
        startFrame: number
        durationInFrames: number
        volume: number
        fadeIn?: number
        fadeOut?: number
      }>
    }

    const fps = projectData.config.fps
    const width = projectData.config.width
    const height = projectData.config.height

    // 计算总帧数
    const totalDuration = projectData.timeline.reduce((sum, clip) => sum + clip.durationInFrames, 0)

    // 创建 Render 目录
    const renderDir = `renders/${projectId}/${editorProjectId}`

    // 渲染视频
    const renderResult = await renderMedia({
      composition: {
        id: 'editor-preview',
        width,
        height,
        fps,
        durationInFrames: totalDuration,
        defaultProps: {
          clips: projectData.timeline,
          bgmTrack: projectData.bgmTrack,
          config: projectData.config
        }
      },
      codec: format === 'webm' ? 'webm' : 'h264',
      inputProps: projectData,
      outDir: renderDir,
      overwrite: true
    })

    // 获取输出文件路径
    const outputKey = `${renderDir}/output.mp4`

    logInfo(`[Editor Render] Completed: ${editorProjectId}, frames: ${totalDuration}`)

    // 更新渲染状态
    await prisma.videoEditorProject.update({
      where: { id: editorProjectId },
      data: {
        renderStatus: 'completed',
        outputUrl: outputKey,
        updatedAt: new Date()
      }
    })

    return NextResponse.json({
      success: true,
      renderStatus: 'completed',
      outputUrl: getSignedUrl(outputKey, 3600),
      totalFrames: totalDuration,
      fps
    })
  } catch (error) {
    _ulogError('[Editor Render] Failed:', error)

    // 更新渲染状态为失败
    await prisma.videoEditorProject.update({
      where: { id: editorProjectId },
      data: {
        renderStatus: 'failed',
        updatedAt: new Date()
      }
    })

    throw new ApiError('RENDER_FAILED', { message: error instanceof Error ? error.message : 'Rendering failed' })
  }
})

/**
 * GET /api/novel-promotion/[projectId]/editor/render?id={editorProjectId}
 * 获取渲染状态
 */
export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await params
  const { searchParams } = new URL(request.url)
  const editorProjectId = searchParams.get('id')

  if (!editorProjectId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const editorProject = await prisma.videoEditorProject.findUnique({
    where: { id: editorProjectId }
  })

  if (!editorProject) {
    throw new ApiError('NOT_FOUND')
  }

  return NextResponse.json({
    status: editorProject.renderStatus,
    outputUrl: editorProject.outputUrl ? getSignedUrl(editorProject.outputUrl, 3600) : null,
    updatedAt: editorProject.updatedAt
  })
})
