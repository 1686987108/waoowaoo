import OpenAI, { toFile } from 'openai'
import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from '../base'
import { getProviderConfig } from '@/lib/api-config'
import { getImageBase64Cached } from '@/lib/image-cache'

type OpenAIImageResponseFormat = 'url' | 'b64_json'
type OpenAIImageOutputFormat = 'png' | 'jpeg' | 'webp'
type OpenAIImageGenerateQuality = 'standard' | 'hd' | 'low' | 'medium' | 'high' | 'auto'
type OpenAIImageEditQuality = 'standard' | 'low' | 'medium' | 'high' | 'auto'
type OpenAIImageGenerateSize =
  | 'auto'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '256x256'
  | '512x512'
  | '1792x1024'
  | '1024x1792'
type OpenAIImageEditSize =
  | 'auto'
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'

function toAbsoluteUrlIfNeeded(value: string): string {
  if (!value.startsWith('/')) return value
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
  return `${baseUrl}${value}`
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const marker = ';base64,'
  const markerIndex = value.indexOf(marker)
  if (!value.startsWith('data:') || markerIndex === -1) return null
  const mimeType = value.slice(5, markerIndex)
  const base64 = value.slice(markerIndex + marker.length)
  if (!mimeType || !base64) return null
  return { mimeType, base64 }
}

function toMimeFromOutputFormat(outputFormat: string | undefined): string {
  if (outputFormat === 'jpeg' || outputFormat === 'jpg') return 'image/jpeg'
  if (outputFormat === 'webp') return 'image/webp'
  return 'image/png'
}

async function toUploadFile(imageSource: string, index: number): Promise<File> {
  const parsedDataUrl = parseDataUrl(imageSource)
  if (parsedDataUrl) {
    const bytes = Buffer.from(parsedDataUrl.base64, 'base64')
    return await toFile(bytes, `reference-${index}.png`, { type: parsedDataUrl.mimeType })
  }

  if (imageSource.startsWith('http://') || imageSource.startsWith('https://') || imageSource.startsWith('/')) {
    const cachedDataUrl = await getImageBase64Cached(toAbsoluteUrlIfNeeded(imageSource))
    const parsedCached = parseDataUrl(cachedDataUrl)
    if (!parsedCached) {
      throw new Error(`OPENAI_IMAGE_REFERENCE_INVALID: failed to parse image source ${index}`)
    }
    const bytes = Buffer.from(parsedCached.base64, 'base64')
    return await toFile(bytes, `reference-${index}.png`, { type: parsedCached.mimeType })
  }

  const bytes = Buffer.from(imageSource, 'base64')
  return await toFile(bytes, `reference-${index}.png`, { type: 'image/png' })
}

/**
 * 将参考图源转换为 data URL 字符串（供 /v1/images/generations 的 image 参数使用）。
 * 与 toUploadFile 逻辑一致，但产物为 JSON body 可直接内联的 data URL。
 */
async function toReferenceDataUrls(imageSources: string[]): Promise<string[]> {
  const results: string[] = []
  for (let index = 0; index < imageSources.length; index += 1) {
    const imageSource = imageSources[index]
    const parsedDataUrl = parseDataUrl(imageSource)
    if (parsedDataUrl) {
      results.push(imageSource)
      continue
    }

    if (imageSource.startsWith('http://') || imageSource.startsWith('https://') || imageSource.startsWith('/')) {
      const cachedDataUrl = await getImageBase64Cached(toAbsoluteUrlIfNeeded(imageSource))
      const parsedCached = parseDataUrl(cachedDataUrl)
      if (!parsedCached) {
        throw new Error(`OPENAI_IMAGE_REFERENCE_INVALID: failed to parse image source ${index}`)
      }
      results.push(cachedDataUrl)
      continue
    }

    results.push(`data:image/png;base64,${imageSource}`)
  }
  return results
}

/**
 * 通过 /v1/images/generations 进行图生图（部分自定义端点不支持 /v1/images/edits，
 * 但支持在 generations 请求中附带 image 参数）。
 */
async function generateWithImage(
  client: OpenAI,
  model: string,
  prompt: string,
  referenceImages: string[],
  extra: {
    responseFormat?: OpenAIImageResponseFormat
    outputFormat?: OpenAIImageOutputFormat
    quality?: OpenAIImageGenerateQuality
    size?: OpenAIImageGenerateSize
  },
): Promise<OpenAI.Images.ImagesResponse> {
  const referenceDataUrls = await toReferenceDataUrls(referenceImages)
  return (await client.images.generate({
    model,
    prompt,
    // OpenAI TS 类型未在 images.generate 暴露 image，但 Agnes 等兼容端点接受该参数
    image: referenceDataUrls as unknown as string,
    ...(extra.responseFormat ? { response_format: extra.responseFormat } : {}),
    ...(extra.outputFormat ? { output_format: extra.outputFormat } : {}),
    ...(extra.quality ? { quality: extra.quality } : {}),
    ...(extra.size ? { size: extra.size } : {}),
  } as unknown as OpenAI.Images.ImageGenerateParams)) as OpenAI.Images.ImagesResponse
}

/**
 * 判断是否为「provider 不支持 /v1/images/edits 端点」导致的失败。
 * 用于触发降级到 generations + image。仅命中 404 / NotFound 类错误时降级，
 * 避免掩盖内容审核、参数错误等真实问题。
 */
function isImagesEditNotSupported(err: unknown): boolean {
  if (err instanceof OpenAI.APIError && err.status === 404) {
    return true
  }
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /not\s*found/i.test(message) || /NotFoundError/i.test(message)
}

function readStringOption(value: unknown, optionName: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_INVALID: ${optionName}`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_INVALID: ${optionName}`)
  }
  return trimmed
}

function normalizeResponseFormat(value: unknown): OpenAIImageResponseFormat | undefined {
  const normalized = readStringOption(value, 'responseFormat')
  if (!normalized) return undefined
  if (normalized === 'url' || normalized === 'b64_json') return normalized
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: responseFormat=${normalized}`)
}

function normalizeOutputFormat(value: unknown): OpenAIImageOutputFormat | undefined {
  const normalized = readStringOption(value, 'outputFormat')
  if (!normalized) return undefined
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') return normalized
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: outputFormat=${normalized}`)
}

function normalizeGenerateQuality(value: unknown): OpenAIImageGenerateQuality | undefined {
  const normalized = readStringOption(value, 'quality')
  if (!normalized) return undefined
  if (
    normalized === 'standard'
    || normalized === 'hd'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'auto'
  ) {
    return normalized
  }
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: quality=${normalized}`)
}

function normalizeEditQuality(value: unknown): OpenAIImageEditQuality | undefined {
  const normalized = readStringOption(value, 'quality')
  if (!normalized) return undefined
  if (
    normalized === 'standard'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'auto'
  ) {
    return normalized
  }
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: quality=${normalized}`)
}

function normalizeGenerateSize(value: string | undefined): OpenAIImageGenerateSize | undefined {
  if (!value) return undefined
  if (
    value === 'auto'
    || value === '1024x1024'
    || value === '1536x1024'
    || value === '1024x1536'
    || value === '256x256'
    || value === '512x512'
    || value === '1792x1024'
    || value === '1024x1792'
  ) {
    return value
  }
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: size=${value}`)
}

function normalizeEditSize(value: string | undefined): OpenAIImageEditSize | undefined {
  if (!value) return undefined
  if (
    value === 'auto'
    || value === '256x256'
    || value === '512x512'
    || value === '1024x1024'
    || value === '1536x1024'
    || value === '1024x1536'
  ) {
    return value
  }
  throw new Error(`OPENAI_COMPATIBLE_IMAGE_OPTION_UNSUPPORTED: size=${value}`)
}

function resolveRawSize(options: Record<string, unknown>): string | undefined {
  const size = readStringOption(options.size, 'size')
  const resolution = readStringOption(options.resolution, 'resolution')
  if (size && resolution && size !== resolution) {
    throw new Error('OPENAI_COMPATIBLE_IMAGE_OPTION_CONFLICT: size and resolution must match')
  }
  return size || resolution
}

function normalizeModel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('OPENAI_COMPATIBLE_IMAGE_OPTION_INVALID: modelId')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('OPENAI_COMPATIBLE_IMAGE_OPTION_INVALID: modelId')
  }
  return trimmed
}

export class OpenAICompatibleImageGenerator extends BaseImageGenerator {
  private readonly modelId?: string
  private readonly providerId?: string

  constructor(modelId?: string, providerId?: string) {
    super()
    this.modelId = modelId
    this.providerId = providerId
  }

  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params
    const providerId = this.providerId || 'openai-compatible'
    const config = await getProviderConfig(userId, providerId)
    if (!config.baseUrl) {
      throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
    }

    const allowedOptionKeys = new Set([
      'provider',
      'modelId',
      'modelKey',
      'size',
      'resolution',
      'quality',
      'responseFormat',
      'outputFormat',
    ])
    // Filter out unknown options silently — custom models may pass extra params
    // (e.g. aspectRatio from project config) that don't apply to OpenAI-compatible APIs
    const filteredOptions: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue
      if (allowedOptionKeys.has(key)) {
        filteredOptions[key] = value
      }
    }

    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    const model = (this.modelId || normalizeModel(options.modelId) || 'gpt-image-1').trim()
    const responseFormat = normalizeResponseFormat(options.responseFormat)
    const outputFormat = normalizeOutputFormat(options.outputFormat)
    const rawSize = resolveRawSize(options)

    let response: OpenAI.Images.ImagesResponse | undefined

    if (referenceImages.length === 0) {
      const quality = normalizeGenerateQuality(options.quality)
      const size = normalizeGenerateSize(rawSize)
      response = await client.images.generate({
        model,
        prompt,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(outputFormat ? { output_format: outputFormat } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
      })
    } else if (config.imageEditMode === 'generate') {
      // 显式配置：此 provider 的图生图走 generations + image（不走 edits）
      response = await generateWithImage(client, model, prompt, referenceImages, {
        responseFormat,
        outputFormat,
        quality: normalizeGenerateQuality(options.quality),
        size: normalizeGenerateSize(rawSize),
      })
    } else {
      // 默认走 edits；若 provider 不支持该端点（404 / NotFound），降级到 generations + image
      const quality = normalizeEditQuality(options.quality)
      const size = normalizeEditSize(rawSize)
      try {
        response = await client.images.edit({
          model,
          prompt,
          image: await Promise.all(referenceImages.map((image, index) => toUploadFile(image, index))),
          ...(responseFormat ? { response_format: responseFormat } : {}),
          ...(outputFormat ? { output_format: outputFormat } : {}),
          ...(quality ? { quality } : {}),
          ...(size ? { size } : {}),
        })
      } catch (err) {
        if (!isImagesEditNotSupported(err)) {
          throw err
        }
        response = await generateWithImage(client, model, prompt, referenceImages, {
          responseFormat,
          outputFormat,
          quality: normalizeGenerateQuality(options.quality),
          size: normalizeGenerateSize(rawSize),
        })
      }
    }

    const image = Array.isArray(response.data) ? response.data[0] : null
    const imageBase64 = image?.b64_json
    if (typeof imageBase64 === 'string' && imageBase64.trim().length > 0) {
      const mimeType = toMimeFromOutputFormat(outputFormat)
      return {
        success: true,
        imageBase64,
        imageUrl: `data:${mimeType};base64,${imageBase64}`,
      }
    }

    const imageUrl = image?.url
    if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return {
        success: true,
        imageUrl,
      }
    }

    throw new Error('OPENAI_IMAGE_EMPTY_RESPONSE: no image data returned')
  }
}
