'use client'

import { useCallback, useMemo } from 'react'
import { useTaskList, type TaskItem } from '@/lib/query/hooks/useTaskStatus'
import { resolveErrorDisplay } from '@/lib/errors/display'
import { useDismissFailedTasks } from '@/lib/query/mutations/task-mutations'

interface UseStoryboardGroupTaskErrorsParams {
  projectId: string
  episodeId: string
}

/**
 * 从数据库查询 panel 级别的任务错误，并提供 dismiss 能力。
 * 只保留每个 panel 的**最新终态任务**（failed / completed / dismissed），
 * 如果最新任务是 completed，则忽略该 panel 的历史 failed 记录，
 * 避免成功生成后仍被旧失败任务覆盖。
 * dismiss 通过 API 将 task 状态改为 'dismissed'，数据库为唯一来源。
 */
export function useStoryboardGroupTaskErrors({
  projectId,
}: UseStoryboardGroupTaskErrorsParams) {
  const panelTerminalTasksQuery = useTaskList({
    projectId,
    targetType: 'NovelPromotionPanel',
    statuses: ['failed', 'completed', 'dismissed'],
    limit: 400,
    enabled: !!projectId,
  })

  const dismissMutation = useDismissFailedTasks(projectId)

  const panelTaskErrorMap = useMemo(() => {
    const map = new Map<string, { taskId: string; message: string }>()
    const tasks = panelTerminalTasksQuery.data || []

    // 按 panel 分组，只取 updatedAt 最新的任务
    const latestByPanel = new Map<string, TaskItem>()
    for (const task of tasks) {
      const existing = latestByPanel.get(task.targetId)
      if (!existing || new Date(task.updatedAt) > new Date(existing.updatedAt)) {
        latestByPanel.set(task.targetId, task)
      }
    }

    // 只有最新任务为 failed 时才显示错误
    for (const task of latestByPanel.values()) {
      if (task.status !== 'failed') continue
      const display = resolveErrorDisplay(task.error || null)
      if (!display) continue
      map.set(task.targetId, { taskId: task.id, message: display.message })
    }

    return map
  }, [panelTerminalTasksQuery.data])

  const clearPanelTaskError = useCallback((panelId: string) => {
    const taskIds = (panelTerminalTasksQuery.data || [])
      .filter((task) => task.targetId === panelId && task.status === 'failed')
      .map((task) => task.id)
    if (taskIds.length === 0) return
    dismissMutation.mutate(taskIds)
  }, [dismissMutation, panelTerminalTasksQuery.data])

  return {
    panelTaskErrorMap,
    clearPanelTaskError,
  }
}
