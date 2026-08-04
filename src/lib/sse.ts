import type { Request, Response } from 'express'
import { logger } from './logger'

/**
 * A small server-sent-events hub. The console listens to it.
 *
 * SSE, not a WebSocket. The flow is one way, it survives a proxy, and it
 * reconnects without any code.
 */
export class SseHub {
  private clients = new Set<Response>()
  private keepAlive: NodeJS.Timeout | null = null

  constructor(private readonly name: string) {}

  subscribe(req: Request, res: Response): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`: connected to ${this.name}\n\n`)
    this.clients.add(res)
    this.startKeepAlive()

    req.on('close', () => {
      this.clients.delete(res)
      if (this.clients.size === 0) this.stopKeepAlive()
    })
  }

  publish(event: string, data: unknown): void {
    if (this.clients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch (error) {
        logger.debug({ err: error }, 'sse write failed, dropping client')
        this.clients.delete(client)
      }
    }
  }

  closeAll(): void {
    this.stopKeepAlive()
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // The socket is already gone. Nothing to do.
      }
    }
    this.clients.clear()
  }

  private startKeepAlive(): void {
    if (this.keepAlive) return
    // A comment line every 20 seconds. It stops a proxy from closing an idle
    // connection.
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n')
    }, 20_000)
    this.keepAlive.unref?.()
  }

  private stopKeepAlive(): void {
    if (!this.keepAlive) return
    clearInterval(this.keepAlive)
    this.keepAlive = null
  }
}

export const events = new SseHub('switch')
