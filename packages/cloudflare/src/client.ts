// client.ts — 有状态 / 有 I/O。所有网络副作用集中于此。

import type {
  CloudflareApiMessage,
  CloudflareConfig,
  DnsEntry,
  DnsRecord,
  ListDnsRecordsOptions,
  ReplaceDnsRecordSetInput,
  ReplaceDnsRecordSetResult,
  SetDnsRecordOptions,
  UpsertDnsRecordInput,
  UpsertDnsRecordResult,
} from './types.js'
import { CloudflareAmbiguousRecordError, CloudflareApiError } from './types.js'
import { normalizeDnsName, parseDnsEntry } from './core.js'

type CloudflareEnvelope<T> = {
  success: boolean
  errors?: CloudflareApiMessage[]
  messages?: CloudflareApiMessage[]
  result: T
  result_info?: {
    page: number
    per_page: number
    count: number
    total_count: number
    total_pages: number
  }
}

export class CloudflareClient {
  private readonly config: Required<
    Pick<CloudflareConfig, 'baseUrl' | 'defaultTtl' | 'defaultProxied'>
  > &
    Omit<CloudflareConfig, 'baseUrl' | 'defaultTtl' | 'defaultProxied'>

  private readonly zoneIdCache = new Map<string, string>()

  constructor(config: CloudflareConfig = {}) {
    const apiToken = config.apiToken ?? process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN
    const email = config.email ?? process.env.CF_EMAIL ?? process.env.CLOUDFLARE_EMAIL
    const apiKey = config.apiKey ?? process.env.CF_API_KEY ?? process.env.CLOUDFLARE_API_KEY

    this.config = {
      ...config,
      apiToken,
      email,
      apiKey,
      baseUrl: trimTrailingSlash(config.baseUrl ?? 'https://api.cloudflare.com/client/v4'),
      defaultTtl: config.defaultTtl ?? 60,
      defaultProxied: config.defaultProxied ?? false,
    }
  }

  async getZoneId(zone = this.zoneName()): Promise<string> {
    const directZoneId = this.config.zoneId
    if (directZoneId && (!zone || zone === this.zoneName())) {
      return directZoneId
    }

    if (!zone) {
      throw new Error('Cloudflare zone name is required when zoneId is not configured')
    }

    const cached = this.zoneIdCache.get(zone)
    if (cached) return cached

    const envelope = await this.request<unknown[]>('GET', '/zones', {
      name: zone,
      status: 'active',
      per_page: '50',
    })
    const zones = envelope.result as Array<{ id: string; name: string }>
    const exact = zones.find((item) => item.name === zone)
    if (!exact) {
      throw new Error(`Cloudflare zone not found: ${zone}`)
    }
    this.zoneIdCache.set(zone, exact.id)
    return exact.id
  }

  async listDnsRecords(options: ListDnsRecordsOptions = {}): Promise<DnsRecord[]> {
    const zoneName = options.zoneName ?? options.zone ?? this.zoneName()
    const zoneId = options.zoneId ?? (await this.getZoneId(zoneName))
    const perPage = String(options.perPage ?? 100)
    const all: DnsRecord[] = []
    let page = 1

    for (;;) {
      const envelope = await this.request<DnsRecord[]>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        removeUndefined({
          type: options.type,
          name: options.name ? normalizeDnsName(options.name, zoneName) : undefined,
          content: options.content,
          page: String(page),
          per_page: perPage,
        }),
      )
      all.push(...envelope.result)

      const totalPages = envelope.result_info?.total_pages ?? 1
      if (page >= totalPages) return all
      page += 1
    }
  }

  async getDnsRecord(options: ListDnsRecordsOptions): Promise<DnsRecord | undefined> {
    const records = await this.listDnsRecords({ ...options, perPage: 100 })
    return records[0]
  }

  async setA(
    name: string,
    content: string,
    options: SetDnsRecordOptions = {},
  ): Promise<UpsertDnsRecordResult> {
    return this.setDnsRecord({ ...options, type: 'A', name, content })
  }

  async setAAAA(
    name: string,
    content: string,
    options: SetDnsRecordOptions = {},
  ): Promise<UpsertDnsRecordResult> {
    return this.setDnsRecord({ ...options, type: 'AAAA', name, content })
  }

  async setDnsRecord(input: UpsertDnsRecordInput): Promise<UpsertDnsRecordResult> {
    const zoneName = input.zoneName ?? input.zone ?? this.zoneName()
    const zoneId = input.zoneId ?? (await this.getZoneId(zoneName))
    const name = normalizeDnsName(input.name, zoneName)
    const ttl = input.ttl ?? this.config.defaultTtl
    const proxied = input.proxied ?? this.config.defaultProxied

    const existing = await this.listDnsRecords({
      zoneName,
      zoneId,
      type: input.type,
      name,
      perPage: 100,
    })

    if (existing.length > 1) {
      throw new CloudflareAmbiguousRecordError(input.type, name, existing)
    }

    const body = removeUndefined({
      type: input.type,
      name,
      content: input.content,
      ttl,
      proxied,
      comment: input.comment,
      tags: input.tags,
    })

    if (existing.length === 0) {
      const envelope = await this.request<DnsRecord>(
        'POST',
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        undefined,
        body,
      )
      return {
        changed: true,
        action: 'created',
        record: envelope.result,
      }
    }

    const current = existing[0]!
    if (recordMatches(current, body)) {
      return {
        changed: false,
        action: 'unchanged',
        record: current,
      }
    }

    const envelope = await this.request<DnsRecord>(
      'PUT',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(current.id)}`,
      undefined,
      body,
    )
    return {
      changed: true,
      action: 'updated',
      previous: current,
      record: envelope.result,
    }
  }

  async createDnsRecord(input: UpsertDnsRecordInput): Promise<DnsRecord> {
    const zoneName = input.zoneName ?? input.zone ?? this.zoneName()
    const zoneId = input.zoneId ?? (await this.getZoneId(zoneName))
    const name = normalizeDnsName(input.name, zoneName)
    const ttl = input.ttl ?? this.config.defaultTtl
    const proxied = input.proxied ?? this.config.defaultProxied
    const body = removeUndefined({
      type: input.type,
      name,
      content: input.content,
      ttl,
      proxied,
      comment: input.comment,
      tags: input.tags,
    })

    const envelope = await this.request<DnsRecord>(
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      undefined,
      body,
    )
    return envelope.result
  }

  async replaceDnsRecordSet(
    input: ReplaceDnsRecordSetInput,
  ): Promise<ReplaceDnsRecordSetResult> {
    const zoneName = input.zoneName ?? input.zone ?? this.zoneName()
    const zoneId = input.zoneId ?? (await this.getZoneId(zoneName))
    const name = normalizeDnsName(input.name, zoneName)
    const ttl = input.ttl ?? this.config.defaultTtl
    const proxied = input.proxied ?? this.config.defaultProxied
    const desiredContents = uniqueStrings(input.contents)

    const existing = await this.listDnsRecords({
      zoneName,
      zoneId,
      type: input.type,
      name,
      perPage: 100,
    })

    const created: DnsRecord[] = []
    const updated: ReplaceDnsRecordSetResult['updated'] = []
    const deleted: DnsRecord[] = []
    const unchanged: DnsRecord[] = []
    const keptByContent = new Map<string, DnsRecord>()
    const desiredSet = new Set(desiredContents)
    const existingByContent = groupBy(existing, (record) => record.content)

    for (const [content, records] of existingByContent) {
      if (!desiredSet.has(content)) {
        for (const record of records) {
          await this.deleteDnsRecord(zoneId, record.id)
          deleted.push(record)
        }
        continue
      }

      const [primary, ...duplicates] = records
      for (const duplicate of duplicates) {
        await this.deleteDnsRecord(zoneId, duplicate.id)
        deleted.push(duplicate)
      }

      const body = removeUndefined({
        type: input.type,
        name,
        content,
        ttl,
        proxied,
        comment: input.comment,
        tags: input.tags,
      })

      if (!primary) continue
      if (recordMatches(primary, body)) {
        unchanged.push(primary)
        keptByContent.set(content, primary)
        continue
      }

      const envelope = await this.request<DnsRecord>(
        'PUT',
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(primary.id)}`,
        undefined,
        body,
      )
      updated.push({ previous: primary, record: envelope.result })
      keptByContent.set(content, envelope.result)
    }

    for (const content of desiredContents) {
      if (keptByContent.has(content)) continue
      const record = await this.createDnsRecord({
        ...input,
        zoneName,
        zoneId,
        name,
        content,
      })
      created.push(record)
      keptByContent.set(content, record)
    }

    const records = desiredContents
      .map((content) => keptByContent.get(content))
      .filter((record): record is DnsRecord => Boolean(record))

    return {
      changed: created.length > 0 || updated.length > 0 || deleted.length > 0,
      name,
      type: input.type,
      records,
      created,
      updated,
      deleted,
      unchanged,
    }
  }

  async deleteDnsRecord(zoneIdOrRecordId: string, recordId?: string): Promise<unknown> {
    const zoneId = recordId ? zoneIdOrRecordId : await this.getZoneId()
    const id = recordId ?? zoneIdOrRecordId
    const envelope = await this.request<unknown>(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
    )
    return envelope.result
  }

  async setMany(entries: DnsEntry[]): Promise<UpsertDnsRecordResult[]> {
    const results: UpsertDnsRecordResult[] = []
    for (const entry of entries) {
      const parsed = parseDnsEntry(entry)
      results.push(await this.setDnsRecord(parsed))
    }
    return results
  }

  private zoneName(): string | undefined {
    return this.config.zoneName ?? this.config.zone
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<CloudflareEnvelope<T>> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch
    if (!fetchImpl) {
      throw new Error('Cloudflare client requires Node.js >=18 or a custom fetch implementation')
    }

    const url = new URL(`${this.config.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }

    const response = await fetchImpl(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    const json = parseJson(text)
    const envelope = json as CloudflareEnvelope<T> | undefined

    if (!response.ok || envelope?.success === false) {
      throw new CloudflareApiError({
        status: response.status,
        method,
        path,
        errors: envelope?.errors,
        messages: envelope?.messages,
        fallbackMessage: text || response.statusText,
      })
    }

    if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) {
      throw new CloudflareApiError({
        status: response.status,
        method,
        path,
        fallbackMessage: `Cloudflare API ${method} ${path} returned an unexpected response`,
      })
    }

    return envelope
  }

  private headers(hasBody: boolean): HeadersInit {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (hasBody) headers['Content-Type'] = 'application/json'

    if (this.config.apiToken) {
      headers.Authorization = `Bearer ${this.config.apiToken}`
      return headers
    }

    if (this.config.email && this.config.apiKey) {
      headers['X-Auth-Email'] = this.config.email
      headers['X-Auth-Key'] = this.config.apiKey
      return headers
    }

    throw new Error(
      'Cloudflare credentials are required: set apiToken or email + apiKey, or configure CF_API_TOKEN / CF_EMAIL + CF_API_KEY',
    )
  }
}

export function createCloudflare(config: CloudflareConfig = {}): CloudflareClient {
  return new CloudflareClient(config)
}

function recordMatches(record: DnsRecord, body: Record<string, unknown>): boolean {
  return (
    record.type === body.type &&
    record.name === body.name &&
    record.content === body.content &&
    record.ttl === body.ttl &&
    (record.proxied ?? false) === (body.proxied ?? false)
  )
}

function removeUndefined<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output as T
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = getKey(item)
    const group = grouped.get(key)
    if (group) group.push(item)
    else grouped.set(key, [item])
  }
  return grouped
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
