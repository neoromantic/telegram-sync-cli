import { isCacheStale } from '../db/types'
import type { PaginatedResult } from '../types'
import { verbose } from './output'

export function buildCachePaginatedResponse<
  TInput extends { fetched_at: number | null },
  TOutput,
>(
  items: TInput[],
  mapItem: (item: TInput) => TOutput,
  options: {
    offset: number
    limit: number
    ttlMs: number
    source: string
    staleMessage?: string
  },
): PaginatedResult<TOutput> & { source: string; stale: boolean } {
  const { offset, limit, ttlMs, source, staleMessage } = options
  const anyStale = items.some((item) => isCacheStale(item.fetched_at, ttlMs))

  if (anyStale) {
    verbose(
      staleMessage ??
        'Cache is stale, consider using --fresh flag to refresh data',
    )
  }

  return {
    items: items.slice(offset, offset + limit).map(mapItem),
    total: items.length,
    offset,
    limit,
    hasMore: offset + limit < items.length,
    source,
    stale: anyStale,
  }
}
