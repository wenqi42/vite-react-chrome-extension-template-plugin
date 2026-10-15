import { afterEach, describe, expect, it } from 'vitest'
import { defineContentScript } from '../client.js'

// These tests use only the documented client API. No dev-server internals or
// runtime registry are inspected.
const stops: Array<() => Promise<void>> = []
let sequence = 0
const identity = () => `content-lifecycle-verifier-${sequence++}`
afterEach(async () => {
  // Error-path tests assert rejection themselves; teardown must still try every
  // remaining mount if one of those explicit stops was intentionally rejected.
  await Promise.allSettled(stops.splice(0).map(stop => stop()))
})

describe('Content Script HMR public lifecycle', () => {
  it('mounts in production without Chrome or a development server', async () => {
    let mounted = 0
    const stop = await defineContentScript(identity(), context => {
      mounted++
      expect(context.data).toEqual({})
      expect(context.signal.aborted).toBe(false)
      expect(typeof context.onDispose).toBe('function')
    })
    stops.push(stop)
    expect(mounted).toBe(1)
    expect(typeof stop).toBe('function')
  })

  it('runs returned cleanup exactly once when explicitly stopped', async () => {
    let cleaned = 0
    const stop = await defineContentScript(identity(), () => () => { cleaned++ })
    stops.push(stop)
    await stop()
    await stop()
    expect(cleaned).toBe(1)
  })

  it('keeps disposal idempotent when an abort listener reenters stop', async () => {
    let cleaned = 0
    let nested!: Promise<void>
    const stop = await defineContentScript(identity(), ({ signal }) => {
      signal.addEventListener('abort', () => { nested = stop() })
      return () => { cleaned++ }
    })
    stops.push(stop)
    await stop()
    await nested
    expect(cleaned).toBe(1)
  })

  it('aborts the old setup and completes asynchronous disposal before replacement', async () => {
    const id = identity()
    const events: string[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let oldSignal!: AbortSignal
    stops.push(await defineContentScript(id, ({ signal }) => {
      oldSignal = signal
      events.push('mount one')
      return async () => {
        events.push('dispose started')
        await held
        events.push('dispose finished')
      }
    }))
    const replacement = defineContentScript(id, () => { events.push('mount two') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oldSignal.aborted).toBe(true)
    expect(events).toEqual(['mount one', 'dispose started'])
    release()
    stops.push(await replacement)
    expect(events).toEqual(['mount one', 'dispose started', 'dispose finished', 'mount two'])
  })

  it('preserves explicitly saved data across three consecutive updates', async () => {
    const id = identity()
    const mounted: unknown[] = []
    for (let revision = 0; revision <= 3; revision++) {
      stops.push(await defineContentScript(id, ({ data, onDispose }) => {
        mounted.push(data.input)
        onDispose(previous => { previous.input = `draft ${revision}` })
      }))
    }
    expect(mounted).toEqual([undefined, 'draft 0', 'draft 1', 'draft 2'])
  })

  it('shares the same preserved data object with cleanup and replacement setup', async () => {
    const id = identity()
    let initial!: Record<string, unknown>
    stops.push(await defineContentScript(id, ({ data, onDispose }) => {
      initial = data
      onDispose(previous => {
        expect(previous).toBe(initial)
        previous.saved = { text: '用户未提交输入' }
      })
    }))
    stops.push(await defineContentScript(id, ({ data }) => {
      expect(data).toBe(initial)
      expect(data.saved).toEqual({ text: '用户未提交输入' })
    }))
  })

  it('cleans both registered disposers and returned cleanup without duplication', async () => {
    const calls = { first: 0, second: 0, returned: 0 }
    const stop = await defineContentScript(identity(), ({ onDispose }) => {
      onDispose(() => { calls.first++ })
      onDispose(async () => {
        await Promise.resolve()
        calls.second++
      })
      return () => { calls.returned++ }
    })
    stops.push(stop)
    await stop()
    await stop()
    expect(calls).toEqual({ first: 1, second: 1, returned: 1 })
  })

  it('awaits an asynchronous setup and its asynchronous returned cleanup', async () => {
    const events: string[] = []
    const stop = await defineContentScript(identity(), async ({ onDispose }) => {
      await Promise.resolve()
      events.push('mounted')
      onDispose(async () => {
        await Promise.resolve()
        events.push('registered disposed')
      })
      return async () => {
        await Promise.resolve()
        events.push('returned disposed')
      }
    })
    stops.push(stop)
    expect(events).toEqual(['mounted'])
    await stop()
    expect(events).toContain('registered disposed')
    expect(events).toContain('returned disposed')
    expect(events).toHaveLength(3)
  })

  it('keeps independent content script identities mounted', async () => {
    const first = identity()
    const second = identity()
    const cleaned: string[] = []
    stops.push(await defineContentScript(first, ({ data }) => {
      data.owner = 'first'
      return () => { cleaned.push('first') }
    }))
    stops.push(await defineContentScript(second, ({ data }) => {
      expect(data).toEqual({})
      data.owner = 'second'
      return () => { cleaned.push('second') }
    }))
    stops.push(await defineContentScript(first, ({ data }) => {
      expect(data.owner).toBe('first')
    }))
    expect(cleaned).toEqual(['first'])
  })

  it('does not let a stale stop function dispose the replacement mount', async () => {
    const id = identity()
    let cleanedNew = 0
    const oldStop = await defineContentScript(id, () => {})
    const newStop = await defineContentScript(id, () => () => { cleanedNew++ })
    stops.push(oldStop, newStop)
    await oldStop()
    expect(cleanedNew).toBe(0)
    await newStop()
    expect(cleanedNew).toBe(1)
  })

  it('serializes simultaneous remounts so each predecessor is cleaned first', async () => {
    const id = identity()
    const events: string[] = []
    const mounted = await Promise.all([1, 2, 3].map(revision =>
      defineContentScript(id, async () => {
        await Promise.resolve()
        events.push(`mount ${revision}`)
        return async () => {
          await Promise.resolve()
          events.push(`dispose ${revision}`)
        }
      }),
    ))
    stops.push(...mounted)
    expect(events).toEqual(['mount 1', 'dispose 1', 'mount 2', 'dispose 2', 'mount 3'])
  })

  it('supports AbortSignal based listener cleanup for every replacement', async () => {
    const id = identity()
    const target = new EventTarget()
    let received = 0
    for (let revision = 0; revision < 4; revision++) {
      stops.push(await defineContentScript(id, ({ signal }) => {
        target.addEventListener('ping', () => { received++ }, { signal })
      }))
      target.dispatchEvent(new Event('ping'))
      expect(received).toBe(revision + 1)
    }
    await stops.at(-1)!()
    target.dispatchEvent(new Event('ping'))
    expect(received).toBe(4)
  })

  it('aborts and disposes a failed setup, then permits a clean mount', async () => {
    const id = identity()
    let oldSignal!: AbortSignal
    let cleaned = 0
    const target = new EventTarget()
    let received = 0
    await expect(defineContentScript(id, ({ signal, onDispose }) => {
      oldSignal = signal
      target.addEventListener('ping', () => { received++ }, { signal })
      onDispose(() => { cleaned++ })
      throw new Error('setup failed deliberately')
    })).rejects.toThrow('setup failed deliberately')
    expect(oldSignal.aborted).toBe(true)
    expect(cleaned).toBe(1)
    target.dispatchEvent(new Event('ping'))
    expect(received).toBe(0)
    stops.push(await defineContentScript(id, ({ signal }) => {
      target.addEventListener('ping', () => { received++ }, { signal })
    }))
    target.dispatchEvent(new Event('ping'))
    expect(received).toBe(1)
  })

  it('attempts all cleanups even if one fails and recovers on the next mount', async () => {
    const id = identity()
    const completed: string[] = []
    let oldSignal!: AbortSignal
    const stop = await defineContentScript(id, ({ signal, onDispose }) => {
      oldSignal = signal
      onDispose(() => { throw new Error('cleanup failed deliberately') })
      onDispose(async () => { completed.push('registered') })
      return () => { completed.push('returned') }
    })
    await expect(stop()).rejects.toThrow()
    expect(oldSignal.aborted).toBe(true)
    expect(completed.sort()).toEqual(['registered', 'returned'])
    let mounted = false
    stops.push(await defineContentScript(id, () => { mounted = true }))
    expect(mounted).toBe(true)
  })

  it('rejects a replacement whose predecessor cleanup fails and later recovers', async () => {
    const id = identity()
    let oldSignal!: AbortSignal
    let oldCleanup = 0
    let newMount = 0
    stops.push(await defineContentScript(id, ({ signal }) => {
      oldSignal = signal
      return () => { oldCleanup++; throw new Error('predecessor cleanup failed') }
    }))
    await expect(defineContentScript(id, () => { newMount++ })).rejects.toThrow()
    expect(oldCleanup).toBe(1)
    expect(oldSignal.aborted).toBe(true)
    expect(newMount).toBe(0)
    stops.push(await defineContentScript(id, () => { newMount++ }))
    expect(newMount).toBe(1)
  })

  it('attempts all registered cleanups after an asynchronous setup rejection', async () => {
    const id = identity()
    const cleaned: string[] = []
    let signal!: AbortSignal
    await expect(defineContentScript(id, async context => {
      signal = context.signal
      context.onDispose(() => { cleaned.push('first'); throw new Error('cleanup also failed') })
      context.onDispose(async () => { await Promise.resolve(); cleaned.push('second') })
      await Promise.resolve()
      throw new Error('async setup failed')
    })).rejects.toThrow()
    expect(cleaned.sort()).toEqual(['first', 'second'])
    expect(signal.aborted).toBe(true)
    stops.push(await defineContentScript(id, () => {}))
  })
})
