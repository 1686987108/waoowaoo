import { NextRequest, NextResponse } from 'next/server'
import { getSignedUrl, toFetchableUrl } from '@/lib/cos'
import { getMediaObjectByPublicId } from '@/lib/media/service'
import * as fs from 'fs/promises'
import * as path from 'path'

export const runtime = 'nodejs'

const STORAGE_TYPE = process.env.STORAGE_TYPE || 'cos'
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads'
const isLocalStorage = STORAGE_TYPE === 'local'
const LOCAL_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function buildEtag(media: { sha256?: string | null; id: string; updatedAt?: string | null }) {
  if (media.sha256) return `"${media.sha256}"`
  return `W/"media-${media.id}-${media.updatedAt || '0'}"`
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await context.params
  const media = await getMediaObjectByPublicId(publicId)

  if (!media) {
    return NextResponse.json({ error: 'Media not found' }, { status: 404 })
  }
  if (!media.storageKey) {
    return NextResponse.json({ error: 'Media storage key missing' }, { status: 500 })
  }

  const etag = buildEtag({
    id: media.id,
    sha256: media.sha256,
    updatedAt: media.updatedAt || null,
  })

  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  // 本地存储模式：直接读取本地文件返回，避免回环 fetch 触发 TLS 证书验证失败
  if (isLocalStorage) {
    const filePath = path.join(process.cwd(), UPLOAD_DIR, media.storageKey as string)
    const normalizedPath = path.normalize(filePath)
    const uploadDirPath = path.normalize(path.join(process.cwd(), UPLOAD_DIR))
    if (!normalizedPath.startsWith(uploadDirPath + path.sep)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    try {
      const buffer = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const contentType = media.mimeType || LOCAL_MIME[ext] || 'application/octet-stream'
      const headers = new Headers()
      headers.set('Content-Type', contentType)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      headers.set('ETag', etag)
      headers.set('Content-Length', String(buffer.length))
      if (contentType.startsWith('video/')) headers.set('Accept-Ranges', 'bytes')
      return new Response(new Uint8Array(buffer), { status: 200, headers })
    } catch (error) {
      const code = (error as { code?: string })?.code
      return NextResponse.json(
        { error: code === 'ENOENT' ? 'File not found' : 'Internal server error' },
        { status: code === 'ENOENT' ? 404 : 500 },
      )
    }
  }

  const fetchUrl = toFetchableUrl(getSignedUrl(media.storageKey))
  const range = request.headers.get('range')

  const upstream = await fetch(fetchUrl, {
    headers: range ? { Range: range } : undefined,
  })

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : 502
    return NextResponse.json({ error: 'Failed to fetch media' }, { status })
  }

  const contentType = media.mimeType || upstream.headers.get('content-type') || 'application/octet-stream'
  const contentLength = upstream.headers.get('content-length')
  const contentRange = upstream.headers.get('content-range')
  const acceptRanges = upstream.headers.get('accept-ranges') || (contentType.startsWith('video/') ? 'bytes' : null)

  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', etag)
  if (contentLength) headers.set('Content-Length', contentLength)
  if (contentRange) headers.set('Content-Range', contentRange)
  if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)

  return new Response(upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  })
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await context.params
  const media = await getMediaObjectByPublicId(publicId)
  if (!media) {
    return NextResponse.json({ error: 'Media not found' }, { status: 404 })
  }

  const etag = buildEtag({
    id: media.id,
    sha256: media.sha256,
    updatedAt: media.updatedAt || null,
  })

  const headers = new Headers()
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', etag)
  if (media.mimeType) headers.set('Content-Type', media.mimeType)
  if (media.sizeBytes != null) headers.set('Content-Length', String(media.sizeBytes))
  return new Response(null, { status: 200, headers })
}
