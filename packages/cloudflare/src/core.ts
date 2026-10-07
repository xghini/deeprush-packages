// core.ts — 纯函数。无 I/O,无状态,可独立引入(@deeprush/cloudflare/core)。

import type { DnsEntry, DnsRecordType, UpsertDnsRecordInput } from './types.js'

export function normalizeDnsName(name: string, zoneName?: string): string {
  const cleanName = name.trim().replace(/\.$/, '')
  const cleanZone = zoneName?.trim().replace(/\.$/, '')

  if (!cleanName) throw new Error('DNS record name is required')
  if (!cleanZone) return cleanName
  if (cleanName === '@') return cleanZone
  if (cleanName === cleanZone || cleanName.endsWith(`.${cleanZone}`)) return cleanName
  return `${cleanName}.${cleanZone}`
}

export function parseDnsEntry(entry: DnsEntry): UpsertDnsRecordInput {
  if (typeof entry !== 'string') {
    return {
      ...entry,
      type: entry.type ?? inferRecordType(entry.content),
    }
  }

  const parts = entry.trim().split(/\s+/)
  if (parts.length < 2) {
    throw new Error(`Invalid DNS entry: ${entry}`)
  }
  const [name, content, type] = parts
  return {
    name: name!,
    content: content!,
    type: (type as DnsRecordType | undefined) ?? inferRecordType(content!),
  }
}

export function inferRecordType(content: string): DnsRecordType {
  return content.includes(':') ? 'AAAA' : 'A'
}
