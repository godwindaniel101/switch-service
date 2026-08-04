import type { Clock } from './ports'

/**
 * The clock of the service, with an offset.
 *
 * The window holds 60 seconds. A test that waits 60 seconds of real time is a
 * bad test. The end-to-end harness moves this offset instead, and 5 minutes
 * of window time pass in one millisecond.
 *
 * The offset is reachable only through the test endpoint, and that endpoint
 * exists only when NODE_ENV is "test". The routing code has no test branch in
 * it: the clock is injected at the edge, and the domain never asks what mode
 * it runs in.
 */
export class OffsetClock implements Clock {
  private offsetMs = 0

  now(): number {
    return Date.now() + this.offsetMs
  }

  isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  advance(ms: number): number {
    this.offsetMs += ms
    return this.offsetMs
  }

  reset(): void {
    this.offsetMs = 0
  }

  get offset(): number {
    return this.offsetMs
  }
}

export const appClock = new OffsetClock()
