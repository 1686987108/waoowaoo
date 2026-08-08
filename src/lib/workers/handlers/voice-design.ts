import type { Job } from 'bullmq'
import { createVoiceDesign, validatePreviewText, validateVoicePrompt, type VoiceDesignInput } from '@/lib/qwen-voice-design'
import { getProviderConfig, getProviderKey, resolveModelSelectionOrSingle } from '@/lib/api-config'
import { synthesizeEdgeTtsToBuffer, pickEdgeVoice } from '@/lib/generators/audio/edge-tts'
import { reportTaskProgress } from '@/lib/workers/shared'
import { assertTaskActive } from '@/lib/workers/utils'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function readLanguage(value: unknown): 'zh' | 'en' {
  return value === 'en' ? 'en' : 'zh'
}

export async function handleVoiceDesignTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as Record<string, unknown>
  const voicePrompt = readRequiredString(payload.voicePrompt, 'voicePrompt')
  const previewText = readRequiredString(payload.previewText, 'previewText')
  const preferredName = typeof payload.preferredName === 'string' && payload.preferredName.trim()
    ? payload.preferredName.trim()
    : 'custom_voice'
  const language = readLanguage(payload.language)

  const promptValidation = validateVoicePrompt(voicePrompt)
  if (!promptValidation.valid) {
    throw new Error(promptValidation.error || 'invalid voicePrompt')
  }
  const textValidation = validatePreviewText(previewText)
  if (!textValidation.valid) {
    throw new Error(textValidation.error || 'invalid previewText')
  }

  await reportTaskProgress(job, 25, {
    stage: 'voice_design_submit',
    stageLabel: '提交声音设计任务',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'voice_design_submit')

  const audioModel = typeof payload.audioModel === 'string' && payload.audioModel.trim()
    ? payload.audioModel.trim()
    : null
  const selection = await resolveModelSelectionOrSingle(job.data.userId, audioModel, 'audio')
  const providerKey = getProviderKey(selection.provider).toLowerCase()

  const input: VoiceDesignInput = {
    voicePrompt,
    previewText,
    preferredName,
    language,
  }

  if (providerKey === 'qwen') {
    const { apiKey } = await getProviderConfig(job.data.userId, selection.provider)
    const designed = await createVoiceDesign(input, apiKey)
    if (!designed.success) {
      throw new Error(designed.error || '声音设计失败')
    }

    await reportTaskProgress(job, 96, {
      stage: 'voice_design_done',
      stageLabel: '声音设计完成',
      displayMode: 'detail',
    })

    return {
      success: true,
      voiceId: designed.voiceId,
      targetModel: designed.targetModel,
      audioBase64: designed.audioBase64,
      sampleRate: designed.sampleRate,
      responseFormat: designed.responseFormat,
      usageCount: designed.usageCount,
      requestId: designed.requestId,
      taskType: job.data.type === TASK_TYPE.ASSET_HUB_VOICE_DESIGN ? TASK_TYPE.ASSET_HUB_VOICE_DESIGN : TASK_TYPE.VOICE_DESIGN,
    }
  }

  if (providerKey === 'edge-tts') {
    // 免费、无需 API Key：用预设神经网络嗓音合成预览（按序号取不同嗓音，保证 3 个方案各不相同）
    const indexMatch = /_(\d+)$/.exec(preferredName)
    const voiceIndex = indexMatch ? Number(indexMatch[1]) - 1 : undefined
    const voice = pickEdgeVoice(language, preferredName, voiceIndex)
    const buf = await synthesizeEdgeTtsToBuffer(previewText, voice, 1.0)

    await reportTaskProgress(job, 96, {
      stage: 'voice_design_done',
      stageLabel: '声音设计完成',
      displayMode: 'detail',
    })

    return {
      success: true,
      voiceId: `edge-tts:${voice}`,
      targetModel: 'edge-tts',
      audioBase64: buf.toString('base64'),
      sampleRate: 24000,
      responseFormat: 'mp3',
      taskType: job.data.type === TASK_TYPE.ASSET_HUB_VOICE_DESIGN ? TASK_TYPE.ASSET_HUB_VOICE_DESIGN : TASK_TYPE.VOICE_DESIGN,
    }
  }

  if (providerKey === 'browser') {
    throw new Error('浏览器内置 TTS 只能在浏览器端实时朗读文本，无法在云端设计自定义音色。请改用 Microsoft Edge TTS（免费、无需 API Key）或配置 Qwen 进行云端音色设计。')
  }

  throw new Error(`当前音频模型「${selection.provider}」不支持云端音色设计。请选择 Edge TTS（免费）或 Qwen（需阿里云 API Key）。`)
}
