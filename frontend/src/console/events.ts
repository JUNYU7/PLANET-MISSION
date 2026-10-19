import { useSyncExternalStore } from 'react'

/**
 * 任务控制台事件流（EVENT LOG）的全局总线。
 *
 * 单例存储 + useSyncExternalStore 订阅：任何模块（场景循环、SSE
 * 消费、导出流程）都可在任意时刻调用 logEvent 推送消息，左栏
 * EventLog 组件自动刷新。上限 200 条，超出丢弃最旧。
 */

export type LogLevel = 'sys' | 'rov' | 'warn' | 'err'

export interface LogEntry {
  id: number
  /** 墙钟时间 hh:mm:ss */
  time: string
  level: LogLevel
  msg: string
}

const MAX = 200
let seq = 0
const entries: LogEntry[] = []
const listeners = new Set<() => void>()
let snapshot: LogEntry[] = []

function tick(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 推送一条事件（任意模块可调用，与 React 渲染周期解耦） */
export function logEvent(level: LogLevel, msg: string): void {
  entries.push({ id: ++seq, time: tick(), level, msg })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
  snapshot = [...entries]
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): LogEntry[] {
  return snapshot
}

/** 订阅事件流的 React Hook */
export function useLogEntries(): LogEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}
