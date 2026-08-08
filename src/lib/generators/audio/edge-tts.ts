/**
 * Microsoft Edge TTS 生成器（免费，无需 API Key）
 *
 * 走微软 Edge 在线神经语音服务（speech.platform.bing.com）合成语音，
 * 完全免费、无需任何 API Key。适合：
 *  - 资产库「AI 设计音色」预览（按语言 + 种子轮换出多个不同嗓音）
 *  - 漫画成片 / 分镜旁白免费朗读
 *
 * 与「浏览器内置 TTS」的区别：本实现在服务端调用微软云端，
 * 产出可落库 / 可下载的 MP3；浏览器 TTS 只能在前端实时朗读，无法落库。
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { EdgeTTS } from 'node-edge-tts'
import { logInfo as _ulogInfo } from '@/lib/logging/core'
import { BaseAudioGenerator, type AudioGenerateParams, type GenerateResult } from '../base'

// 免费神经网络音色（中 / 英），按语言与种子轮换，保证「多个音色方案」各不相同
export const EDGE_VOICES_ZH = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunxiaNeural',
]
export const EDGE_VOICES_EN = [
  'en-US-AriaNeural',
  'en-US-GuyNeural',
  'en-US-JennyNeural',
]

function pickList(language: 'zh' | 'en'): string[] {
  return language === 'en' ? EDGE_VOICES_EN : EDGE_VOICES_ZH
}

/** 根据语言 + 种子字符串稳定挑选一个 Edge 音色（同一 seed 始终得到同一嗓音） */
export function pickEdgeVoice(language: 'zh' | 'en', seed: string, index?: number): string {
  const list = pickList(language)
  if (typeof index === 'number' && index >= 0 && Number.isFinite(index)) {
    return list[index % list.length]
  }
  let h = 0
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return list[h % list.length]
}

/** 简单按字符判定中 / 英（Edge 中文嗓音以 zh-CN 开头） */
export function detectEdgeLanguage(text: string): 'zh' | 'en' {
  return /[一-龥]/.test(text) ? 'zh' : 'en'
}

/** 合成文本为 MP3 缓冲（Edge TTS 免费服务，临时文件落盘后读回并清理） */
export async function synthesizeEdgeTtsToBuffer(
  text: string,
  voice: string,
  rate = 1.0,
): Promise<Buffer> {
  const tmp = path.join(
    os.tmpdir(),
    `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
  )
  try {
    const rateStr = rate && rate !== 1 ? `${Math.round((rate - 1) * 100)}%` : '+0%'
    const tts = new EdgeTTS({
      voice,
      lang: voice.split('-')[0],
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: rateStr,
    })
    _ulogInfo(`[EdgeTTS] synthesize voice=${voice} rate=${rateStr} len=${text.length}`)
    await tts.ttsPromise(text, tmp)
    return fs.readFileSync(tmp)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件清理失败可忽略
    }
  }
}

/** 供生成器工厂使用的 Edge TTS 实现（返回 base64，便于落库 / 预览） */
export class EdgeTtsGenerator extends BaseAudioGenerator {
  protected async doGenerate(params: AudioGenerateParams): Promise<GenerateResult> {
    const { text, voice = 'zh-CN-XiaoxiaoNeural', rate = 1.0 } = params
    if (!text || !text.trim()) {
      return { success: false, error: '音频文本为空' }
    }
    const language = detectEdgeLanguage(text)
    const selectedVoice = voice && voice.includes('Neural') ? voice : pickEdgeVoice(language, voice || text)
    const buf = await synthesizeEdgeTtsToBuffer(text, selectedVoice, rate)
    const base64 = buf.toString('base64')
    return {
      success: true,
      audioUrl: `data:audio/mp3;base64,${base64}`,
    }
  }
}
