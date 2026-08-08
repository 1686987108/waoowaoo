'use client'

import type { CSSProperties, ImgHTMLAttributes, MouseEventHandler } from 'react'

export type MediaImageProps = {
  src: string | null | undefined
  alt: string
  className?: string
  style?: CSSProperties
  onClick?: MouseEventHandler<HTMLImageElement>
  fill?: boolean
  width?: number
  height?: number
  sizes?: string
  priority?: boolean
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'>

function isStableMediaRoute(src: string) {
  return src.startsWith('/m/')
}

export function MediaImage({
  src,
  alt,
  className,
  style,
  onClick,
  fill = false,
  width = 1200,
  height = 1200,
  sizes,
  priority = false,
  ...imgProps
}: MediaImageProps) {
  if (!src) return null

  // /m/<publicId> 是项目自身的动态媒体路由，已经能正确返回图片并带缓存头。
  // 在 Next.js 15 + Turbopack dev 模式下，next/image 对动态路由会走到内部的
  // /api/asset?ar=... 优化端点，该端点无法识别 /m/ 资源并返回 400。
  // 因此所有 /m/ 路径直接走原生 <img>，避免经过 next/image 优化器。
  if (isStableMediaRoute(src)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        className={className}
        style={style}
        onClick={onClick}
        loading={priority ? 'eager' : 'lazy'}
        {...imgProps}
      />
    )
  }

  return (
    // 外部 URL 兜底，避免 next/image 远程域名限制影响兼容链路
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      onClick={onClick}
      loading={priority ? 'eager' : 'lazy'}
      {...imgProps}
    />
  )
}
