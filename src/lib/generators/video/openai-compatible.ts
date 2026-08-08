import OpenAI, { toFile } from 'openai'
import { BaseVideoGenerator, type GenerateResult, type VideoGenerateParams } from '../base'
import { getProviderConfig } from '@/lib/api-config'
import { imageUrlToBase64 } from '@/lib/cos'

type OpenAIVideoSize = '720x1280' | '1280x720' | '1024x1792' | '1792x1024'
type OpenAIVideoSeconds = '4' | '8' | '12'
type OpenAIVideoAspectRatio =
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '3:2'
  | '2:3'
  | '21:9'
  | '9:21'
  | '1:1'
  | 'auto'

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const marker = ';base64,'
  const markerIndex = value.indexOf(marker)
  if (!value.startsWith('data:') || markerIndex === -1) return null
  const mimeType = value.slice(5, markerIndex)
  const base64 = value.slice(markerIndex + marker.length)
  if (!mimeType || !base64) return null
  return { mimeType, base64 }
}

function normalizeDuration(value: unknown): OpenAIVideoSeconds | undefined {
  if (value === 4 || value === '4') return '4'
  if (value === 8 || value === '8') return '8'
  if (value === 12 || value === '12') return '12'
  if (value === undefined) return undefined
  throw new Error(`OPENAI_VIDEO_DURATION_UNSUPPORTED: ${String(value)}`)
}

function normalizeAspectRatio(value: unknown): OpenAIVideoAspectRatio | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`OPENAI_VIDEO_ASPECT_RATIO_UNSUPPORTED: ${String(value)}`)
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (
    trimmed === '16:9'
    || trimmed === '9:16'
    || trimmed === '4:3'
    || trimmed === '3:4'
    || trimmed === '3:2'
    || trimmed === '2:3'
    || trimmed === '21:9'
    || trimmed === '9:21'
    || trimmed === '1:1'
    || trimmed === 'auto'
  ) {
    return trimmed
  }
  throw new Error(`OPENAI_VIDEO_ASPECT_RATIO_UNSUPPORTED: ${trimmed}`)
}

function normalizeModel(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'sora-2'
  if (typeof value !== 'string') {
    throw new Error(`OPENAI_VIDEO_MODEL_INVALID: ${String(value)}`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('OPENAI_VIDEO_MODEL_INVALID: empty model id')
  }
  return trimmed
}

function resolveSizeOrientation(aspectRatio: OpenAIVideoAspectRatio | undefined): 'portrait' | 'landscape' {
  if (
    aspectRatio === '9:16'
    || aspectRatio === '3:4'
    || aspectRatio === '2:3'
    || aspectRatio === '9:21'
  ) {
    return 'portrait'
  }
  return 'landscape'
}

function normalizeSize(value: unknown, aspectRatio: OpenAIVideoAspectRatio | undefined): OpenAIVideoSize | undefined {
  if (value === '720x1280' || value === '1280x720' || value === '1024x1792' || value === '1792x1024') {
    return value
  }

  const orientation = resolveSizeOrientation(aspectRatio)

  if (value === '720p') {
    return orientation === 'portrait' ? '720x1280' : '1280x720'
  }
  if (value === '1080p') {
    return orientation === 'portrait' ? '1024x1792' : '1792x1024'
  }

  if (value === undefined) return undefined
  throw new Error(`OPENAI_VIDEO_SIZE_UNSUPPORTED: ${String(value)}`)
}

function resolveFinalSize(options: Record<string, unknown>): OpenAIVideoSize | undefined {
  const aspectRatioRaw = options.aspectRatio ?? options.aspect_ratio
  const aspectRatio = normalizeAspectRatio(aspectRatioRaw)
  const rawSize = options.size
  const rawResolution = options.resolution
  const normalizedSize = rawSize === undefined ? undefined : normalizeSize(rawSize, aspectRatio)
  const normalizedResolution = rawResolution === undefined ? undefined : normalizeSize(rawResolution, aspectRatio)
  if (normalizedSize && normalizedResolution && normalizedSize !== normalizedResolution) {
    throw new Error('OPENAI_VIDEO_SIZE_CONFLICT: size and resolution must match')
  }
  return normalizedSize || normalizedResolution
}

export function encodeProviderId(providerId: string): string {
  return Buffer.from(providerId, 'utf8').toString('base64url')
}

async function toUploadFileFromImageUrl(imageUrl: string): Promise<File> {
  const base64DataUrl = imageUrl.startsWith('data:') ? imageUrl : await imageUrlToBase64(imageUrl)
  const parsed = parseDataUrl(base64DataUrl)
  if (!parsed) {
    throw new Error('OPENAI_VIDEO_INPUT_REFERENCE_INVALID')
  }
  const bytes = Buffer.from(parsed.base64, 'base64')
  return await toFile(bytes, 'input-reference.png', { type: parsed.mimeType })
}

/**
 * Fallback: POST /video/create (非 OpenAI 标准，部分网关使用此格式)
 * 返回 { id, status } 格式
 */
async function createVideoViaFetchFallback(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/video/create`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OPENAI_VIDEO_CREATE_FALLBACK_FAILED: ${response.status} ${text.slice(0, 200)}`)
  }

  const data = await response.json() as Record<string, unknown>
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  if (!id) {
    throw new Error('OPENAI_VIDEO_CREATE_FALLBACK_INVALID_RESPONSE: missing id')
  }
  return { id }
}

/**
 * Re-issue the video create request via raw fetch to capture the provider's
 * real error body. OpenAI SDK v6 swallows the HTTP response body on 4xx/5xx
 * (throws "400 status code (no body)"), so when the SDK fails we replay the
 * request once to obtain Agnes's actual error (e.g. content_policy_violation).
 */
async function fetchVideoProviderError(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ code?: string; message?: unknown } | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/videos`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    })
    if (response.ok) return null
    const data = (await response.json().catch(() => null)) as { code?: string; message?: unknown } | null
    if (data && (typeof data.code === 'string' || data.message !== undefined)) return data
    return { message: `${response.status} ${response.statusText}` }
  } catch {
    return null
  }
}

/**
 * 判断是否为端点不支持的错误（404/405/500 无 body 等）
 */
function isEndpointUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  // OpenAI SDK wraps HTTP errors with status codes
  if (/\b(404|405)\b/.test(message)) return true
  // 500 with no body typically means the gateway doesn't support this endpoint
  if (/500\s*status\s*code\s*\(no\s*body\)/i.test(message)) return true
  // Some gateways return error JSON with specific codes
  if (/get_channel_failed/i.test(message)) return true
  // Check for status property on error object
  const statusCode = (error as { status?: number }).status
  if (statusCode === 404 || statusCode === 405) return true
  return false
}

/**
 * 判断是否为 provider 只接受 JSON 请求体的错误（multipart 走 SDK 时常见）
 */
function isJsonOnlyEndpointError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  if (/only\s*supports\s*Content-Type:\s*application\/json/i.test(message)) return true
  if (/Please\s*send\s*a\s*JSON\s*request\s*body/i.test(message)) return true
  const statusCode = (error as { status?: number }).status
  return statusCode === 400 && (/application\/json/i.test(message) || /JSON/i.test(message))
}

export class OpenAICompatibleVideoGenerator extends BaseVideoGenerator {
  private readonly providerId?: string

  constructor(providerId?: string) {
    super()
    this.providerId = providerId
  }

  protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params
    const providerId = this.providerId || 'openai-compatible'
    const config = await getProviderConfig(userId, providerId)
    if (!config.baseUrl) {
      throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
    }

    // Filter out unknown options silently — custom models may pass extra params
    const allowedOptionKeys = new Set([
      'provider',
      'modelId',
      'modelKey',
      'duration',
      'resolution',
      'aspectRatio',
      'aspect_ratio',
      'size',
      'generateAudio',
      'generationMode',
    ])
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue
      if (!allowedOptionKeys.has(key)) {
        // Silently skip unknown options for custom model compatibility
      }
    }

    const model = normalizeModel(options.modelId)
    const seconds = normalizeDuration(options.duration)
    const size = resolveFinalSize(options)
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      throw new Error('OPENAI_VIDEO_PROMPT_REQUIRED')
    }

    const requestPayload: Record<string, unknown> = {
      prompt: trimmedPrompt,
      model,
      ...(seconds ? { seconds } : {}),
      ...(size ? { size } : {}),
    }

    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })

    async function createVideoViaSdk(imageParam: unknown): Promise<string> {
      const sdkPayload = {
        ...requestPayload,
        ...(imageParam !== undefined ? { image: imageParam } : {}),
      }
      try {
        const response = await client.videos.create(
          sdkPayload as Parameters<typeof client.videos.create>[0],
        )
        if (!response.id || typeof response.id !== 'string') {
          throw new Error('OPENAI_VIDEO_CREATE_INVALID_RESPONSE: missing video id')
        }
        return response.id
      }
      catch (sdkError) {
        // OpenAI SDK v6 loses the HTTP response body on 4xx/5xx ("400 status code
        // (no body)"). Replay once via raw fetch to capture Agnes's real error so
        // we can surface content-policy rejections instead of a generic 400.
        const status = (sdkError as { status?: number })?.status
        const sdkMessage = sdkError instanceof Error ? sdkError.message : String(sdkError)
        const needsBody = status === 400 || status === undefined || /no body/i.test(sdkMessage)
        if (needsBody) {
          const providerError = await fetchVideoProviderError(config.baseUrl!, config.apiKey, sdkPayload).catch(() => null)
          if (providerError) {
            const code = String(providerError.code ?? '').toLowerCase()
            const detail = typeof providerError.message === 'string'
              ? providerError.message
              : providerError.message !== undefined
                ? JSON.stringify(providerError.message)
                : ''
            const isPolicy = /policy_violation|content_policy|moderation|sensitive|unsafe/i.test(code)
              || /policy_violation|content_policy|moderation|sensitive|unsafe/i.test(detail)
            if (isPolicy) {
              throw new Error(`SENSITIVE_CONTENT_VIOLATION (policy_violation): ${detail || 'Content policy violation'}`)
            }
            if (detail) {
              throw new Error(`PROVIDER_VIDEO_ERROR: ${detail}`)
            }
          }
        }
        throw sdkError
      }
    }

    async function createVideoViaFetchFallbackWrapper(): Promise<string> {
      const fallbackPayload: Record<string, unknown> = { ...requestPayload }
      if (imageUrl) {
        fallbackPayload.image_url = imageUrl
      }
      const fallbackResult = await createVideoViaFetchFallback(
        config.baseUrl!,
        config.apiKey,
        fallbackPayload,
      )
      return fallbackResult.id
    }

    /**
     * Strategy:
     * 1. If provider explicitly configured as videoMode='json',
     *    send application/json with image as base64 data URL (Agnes 等自定义端点)。
     * 2. Otherwise default to SDK multipart with input_reference: File。
     *    - If provider returns "only supports application/json", retry with JSON image。
     *    - If endpoint is unsupported (404/405), fallback to /video/create。
     */
    let videoId: string

    if (config.videoMode === 'json') {
      videoId = await createVideoViaSdk(imageUrl)
    }
    else {
      let inputReference: File | undefined
      if (imageUrl) {
        inputReference = await toUploadFileFromImageUrl(imageUrl)
      }

      try {
        const sdkPayload = {
          ...requestPayload,
          ...(inputReference ? { input_reference: inputReference } : {}),
        }
        const response = await client.videos.create(
          sdkPayload as Parameters<typeof client.videos.create>[0],
        )
        if (!response.id || typeof response.id !== 'string') {
          throw new Error('OPENAI_VIDEO_CREATE_INVALID_RESPONSE: missing video id')
        }
        videoId = response.id
      }
      catch (sdkError) {
        if (isJsonOnlyEndpointError(sdkError) && imageUrl) {
          try {
            videoId = await createVideoViaSdk(imageUrl)
          }
          catch (jsonError) {
            if (isEndpointUnsupportedError(jsonError)) {
              videoId = await createVideoViaFetchFallbackWrapper()
            }
            else {
              throw jsonError
            }
          }
        }
        else if (isEndpointUnsupportedError(sdkError)) {
          videoId = await createVideoViaFetchFallbackWrapper()
        }
        else {
          throw sdkError
        }
      }
    }

    const providerToken = encodeProviderId(config.id)
    return {
      success: true,
      async: true,
      requestId: videoId,
      externalId: `OPENAI:VIDEO:${providerToken}:${videoId}`,
    }
  }
}
