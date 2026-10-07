// types.ts — 纯类型与错误类。零逻辑,零运行时依赖(除 Error 继承)。

export type DnsRecordType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'TXT'
  | 'MX'
  | 'NS'
  | 'SRV'
  | 'CAA'

export type CloudflareFetch = typeof fetch

export type CloudflareConfig = {
  /**
   * Zone name, for example "example.com".
   */
  zone?: string
  zoneName?: string
  /**
   * Optional known zone id. If omitted, the client resolves it from the zone name.
   */
  zoneId?: string
  apiToken?: string
  email?: string
  apiKey?: string
  baseUrl?: string
  fetch?: CloudflareFetch
  defaultTtl?: number
  defaultProxied?: boolean
}

export type DnsRecord = {
  id: string
  zone_id: string
  zone_name: string
  name: string
  type: DnsRecordType
  content: string
  proxiable?: boolean
  proxied?: boolean
  ttl: number
  locked?: boolean
  comment?: string | null
  tags?: string[]
  created_on?: string
  modified_on?: string
  meta?: Record<string, unknown>
}

export type ListDnsRecordsOptions = {
  zone?: string
  zoneName?: string
  zoneId?: string
  type?: DnsRecordType
  name?: string
  content?: string
  perPage?: number
}

export type SetDnsRecordOptions = {
  zone?: string
  zoneName?: string
  zoneId?: string
  ttl?: number
  proxied?: boolean
  comment?: string
  tags?: string[]
}

export type UpsertDnsRecordInput = SetDnsRecordOptions & {
  type: DnsRecordType
  name: string
  content: string
}

export type UpsertDnsRecordResult = {
  changed: boolean
  action: 'created' | 'updated' | 'unchanged'
  record: DnsRecord
  previous?: DnsRecord
}

export type ReplaceDnsRecordSetInput = SetDnsRecordOptions & {
  type: DnsRecordType
  name: string
  contents: string[]
}

export type ReplaceDnsRecordSetResult = {
  changed: boolean
  name: string
  type: DnsRecordType
  records: DnsRecord[]
  created: DnsRecord[]
  updated: Array<{
    previous: DnsRecord
    record: DnsRecord
  }>
  deleted: DnsRecord[]
  unchanged: DnsRecord[]
}

/**
 * One DNS upsert entry: either "name content [type]" as a string,
 * or a structured object. Type defaults by content shape (":" → AAAA, else A).
 */
export type DnsEntry =
  | string
  | (SetDnsRecordOptions & {
      name: string
      content: string
      type?: DnsRecordType
    })

export type CloudflareApiMessage = {
  code?: number
  message: string
  documentation_url?: string
  source?: unknown
}

export class CloudflareApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly errors: CloudflareApiMessage[]
  readonly messages: CloudflareApiMessage[]

  constructor(input: {
    status: number
    method: string
    path: string
    errors?: CloudflareApiMessage[]
    messages?: CloudflareApiMessage[]
    fallbackMessage?: string
  }) {
    const details = input.errors?.map((item) => item.message).filter(Boolean)
    super(
      details?.length
        ? `Cloudflare API ${input.method} ${input.path} failed: ${details.join('; ')}`
        : (input.fallbackMessage ??
            `Cloudflare API ${input.method} ${input.path} failed with status ${input.status}`),
    )
    this.name = 'CloudflareApiError'
    this.status = input.status
    this.method = input.method
    this.path = input.path
    this.errors = input.errors ?? []
    this.messages = input.messages ?? []
  }
}

export class CloudflareAmbiguousRecordError extends Error {
  readonly records: DnsRecord[]

  constructor(type: DnsRecordType, name: string, records: DnsRecord[]) {
    super(
      `Cloudflare DNS record ${type} ${name} is ambiguous: ${records.length} records already exist`,
    )
    this.name = 'CloudflareAmbiguousRecordError'
    this.records = records
  }
}
