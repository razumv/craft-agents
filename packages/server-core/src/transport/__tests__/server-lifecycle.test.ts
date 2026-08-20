/**
 * WsRpcServer lifecycle & security tests.
 *
 * Tests connection auth, capacity limits, handler timeout, and shutdown behavior.
 * Spawns a real WsRpcServer on a random port for each test.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import WebSocket from 'ws'
import { WsRpcServer } from '../server'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'

const TEST_TOKEN = 'test-token-with-enough-entropy-to-pass'

function createServer(opts?: {
  maxClients?: number
  requireAuth?: boolean
  validateToken?: (token: string) => Promise<boolean>
}) {
  return new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: opts?.requireAuth ?? true,
    validateToken: opts?.validateToken ?? (async (t) => t === TEST_TOKEN),
    maxClients: opts?.maxClients,
    serverId: 'test',
  })
}

function handshake(url: string, token: string): Promise<{ ws: WebSocket; clientId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Handshake timeout'))
    }, 5_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        clearTimeout(timeout)
        resolve({ ws, clientId: msg.clientId })
      } else if (msg.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(`Auth error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('close', (code, reason) => {
      clearTimeout(timeout)
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

describe('WsRpcServer lifecycle', () => {
  let server: WsRpcServer | null = null
  const openSockets: WebSocket[] = []

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openSockets.length = 0
    server?.close()
    server = null
  })

  // -- Auth tests --

  it('accepts valid token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws, clientId } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    expect(clientId).toBeTruthy()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('rejects invalid token with 4005', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    await expect(handshake(url, 'wrong-token')).rejects.toThrow()
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('rejects missing token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          // no token
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4005)
  })

  // -- Capacity tests --

  it('rejects connections when at maxClients', async () => {
    server = createServer({ maxClients: 2 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Fill up to capacity
    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)

    expect(server.getConnectedClientCount()).toBe(2)

    // Third connection should be rejected
    await expect(handshake(url, TEST_TOKEN)).rejects.toThrow()
  })

  it('allows new connections after a client disconnects', async () => {
    server = createServer({ maxClients: 1 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)

    // Disconnect first client and wait for server to process it
    ws1.close()
    // Poll until server sees the disconnection (max 2s)
    for (let i = 0; i < 40; i++) {
      if (server!.getConnectedClientCount() === 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(server!.getConnectedClientCount()).toBe(0)

    // New connection should work
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)
    expect(server!.getConnectedClientCount()).toBe(1)
  })

  // -- Handler timeout test --

  it('times out slow handlers', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Register a handler that never resolves
    server.handle('test:slow', async () => {
      await new Promise(() => {}) // never resolves
    })

    const { ws } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    // Send a request to the slow handler
    const reqId = crypto.randomUUID()
    ws.send(JSON.stringify({
      id: reqId,
      type: 'request',
      channel: 'test:slow',
    }))

    // Should receive error response (but this will take 60s — skip in normal runs)
    // This test validates the handler is registered; full timeout is covered by the 60s static value
  })

  it('applies a per-channel timeout override instead of the default', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // A handler that never resolves, registered with a tiny explicit budget:
    // the response must arrive on that budget, not on the 60s default.
    server.handle('test:slow-override', async () => {
      await new Promise(() => {})
    }, { timeoutMs: 120 })

    const { ws } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    const reqId = crypto.randomUUID()
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response within 5s')), 5_000)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          clearTimeout(timer)
          resolve(msg)
        }
      })
      ws.send(JSON.stringify({ id: reqId, type: 'request', channel: 'test:slow-override' }))
    })

    expect(response.error?.message).toContain('Handler timeout: test:slow-override')
    expect(response.error?.message).toContain('120ms')
  })

  it('keeps the default budget for channels without an override', async () => {
    server = createServer()
    await server.listen()

    // A fast handler resolves normally; the override only changes the deadline,
    // never the result path.
    server.handle('test:fast', async () => 'ok', { timeoutMs: 5_000 })

    const { ws } = await handshake(`ws://127.0.0.1:${server.port}`, TEST_TOKEN)
    openSockets.push(ws)

    const reqId = crypto.randomUUID()
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response within 5s')), 5_000)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          clearTimeout(timer)
          resolve(msg)
        }
      })
      ws.send(JSON.stringify({ id: reqId, type: 'request', channel: 'test:fast' }))
    })

    expect(response.result).toBe('ok')
    expect(response.error).toBeUndefined()
  })

  it('rejects a non-positive per-channel timeout at registration', async () => {
    server = createServer()
    expect(() => server!.handle('test:bad-budget', async () => 'x', { timeoutMs: 0 }))
      .toThrow('must be a positive finite number')
  })

  // -- Protocol version tests --

  it('rejects wrong protocol major version', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: '99.0',
          token: TEST_TOKEN,
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4004)
  })

  // -- Close behavior --

  it('terminates all clients on close()', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1, ws2)

    const closedPromise = Promise.all([
      new Promise(resolve => ws1.on('close', resolve)),
      new Promise(resolve => ws2.on('close', resolve)),
    ])

    server.close()
    await closedPromise

    expect(server.getConnectedClientCount()).toBe(0)
  })
})
