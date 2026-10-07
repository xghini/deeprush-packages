import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CloudflareAmbiguousRecordError,
  createCloudflare,
  normalizeDnsName,
} from '../dist/index.js'
import { parseDnsEntry } from '../dist/core.js'

test('normalizes relative names with zone', () => {
  assert.equal(normalizeDnsName('edge-1', 'example.com'), 'edge-1.example.com')
  assert.equal(normalizeDnsName('@', 'example.com'), 'example.com')
  assert.equal(normalizeDnsName('edge-1.example.com', 'example.com'), 'edge-1.example.com')
})

test('parses DNS entry strings', () => {
  assert.deepEqual(parseDnsEntry('edge-1 203.0.113.10'), {
    name: 'edge-1',
    content: '203.0.113.10',
    type: 'A',
  })
  assert.deepEqual(parseDnsEntry('edge-1 2606:4700::1'), {
    name: 'edge-1',
    content: '2606:4700::1',
    type: 'AAAA',
  })
})

test('creates missing A record', async () => {
  const calls = []
  const cf = createCloudflare({
    zone: 'example.com',
    zoneId: 'zone-1',
    apiToken: 'token',
    fetch: mockFetch(calls, [
      ok({
        result: [],
        result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 1 },
      }),
      ok({
        result: {
          id: 'record-1',
          zone_id: 'zone-1',
          zone_name: 'example.com',
          name: 'edge-1.example.com',
          type: 'A',
          content: '203.0.113.10',
          ttl: 60,
          proxied: false,
        },
      }),
    ]),
  })

  const result = await cf.setA('edge-1', '203.0.113.10')

  assert.equal(result.action, 'created')
  assert.equal(result.changed, true)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[1].method, 'POST')
  assert.equal(calls[1].body.name, 'edge-1.example.com')
})

test('does not update unchanged single record', async () => {
  const calls = []
  const cf = createCloudflare({
    zone: 'example.com',
    zoneId: 'zone-1',
    apiToken: 'token',
    fetch: mockFetch(calls, [
      ok({
        result: [
          {
            id: 'record-1',
            zone_id: 'zone-1',
            zone_name: 'example.com',
            name: 'edge-1.example.com',
            type: 'A',
            content: '203.0.113.10',
            ttl: 60,
            proxied: false,
          },
        ],
        result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 },
      }),
    ]),
  })

  const result = await cf.setA('edge-1', '203.0.113.10')

  assert.equal(result.action, 'unchanged')
  assert.equal(result.changed, false)
  assert.equal(calls.length, 1)
})

test('throws on duplicate same-name records', async () => {
  const cf = createCloudflare({
    zone: 'example.com',
    zoneId: 'zone-1',
    apiToken: 'token',
    fetch: mockFetch([], [
      ok({
        result: [
          {
            id: 'record-1',
            zone_id: 'zone-1',
            zone_name: 'example.com',
            name: 'edge-1.example.com',
            type: 'A',
            content: '203.0.113.10',
            ttl: 60,
            proxied: false,
          },
          {
            id: 'record-2',
            zone_id: 'zone-1',
            zone_name: 'example.com',
            name: 'edge-1.example.com',
            type: 'A',
            content: '203.0.113.11',
            ttl: 60,
            proxied: false,
          },
        ],
        result_info: { page: 1, per_page: 100, count: 2, total_count: 2, total_pages: 1 },
      }),
    ]),
  })

  await assert.rejects(() => cf.setA('edge-1', '203.0.113.10'), {
    name: 'CloudflareAmbiguousRecordError',
  })
  assert.equal(CloudflareAmbiguousRecordError.name, 'CloudflareAmbiguousRecordError')
})

test('replaces multi-record set and removes stale records', async () => {
  const calls = []
  const cf = createCloudflare({
    zone: 'example.com',
    zoneId: 'zone-1',
    apiToken: 'token',
    fetch: mockFetch(calls, [
      ok({
        result: [
          record('record-1', 'pool.example.com', 'A', '1.1.1.1'),
          record('record-2', 'pool.example.com', 'A', '2.2.2.2'),
          record('record-3', 'pool.example.com', 'A', '1.1.1.1'),
        ],
        result_info: { page: 1, per_page: 100, count: 3, total_count: 3, total_pages: 1 },
      }),
      ok({ result: {} }),
      ok({ result: {} }),
      ok({
        result: record('record-4', 'pool.example.com', 'A', '3.3.3.3'),
      }),
    ]),
  })

  const result = await cf.replaceDnsRecordSet({
    name: 'pool',
    type: 'A',
    contents: ['1.1.1.1', '3.3.3.3', '3.3.3.3'],
  })

  assert.equal(result.changed, true)
  assert.deepEqual(
    result.records.map((item) => item.content),
    ['1.1.1.1', '3.3.3.3'],
  )
  assert.deepEqual(
    result.deleted.map((item) => item.id),
    ['record-3', 'record-2'],
  )
  assert.deepEqual(
    calls.map((item) => item.method),
    ['GET', 'DELETE', 'DELETE', 'POST'],
  )
  assert.equal(calls[0].url.includes('name=pool.example.com'), true)
  assert.equal(calls[3].body.content, '3.3.3.3')
})

function ok(body) {
  return {
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [],
      ...body,
    },
  }
}

function record(id, name, type, content) {
  return {
    id,
    zone_id: 'zone-1',
    zone_name: 'example.com',
    name,
    type,
    content,
    ttl: 60,
    proxied: false,
  }
}

function mockFetch(calls, responses) {
  return async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    const response = responses.shift()
    if (!response) throw new Error('Unexpected fetch call')
    return new Response(JSON.stringify(response.body), { status: response.status })
  }
}
