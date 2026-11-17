import { isCacheStale } from '../db/types'
import type { PaginatedResult } from '../types'
import { verbose } from './output'

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): PaginatedResult<T> {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    hasMore: offset + limit < items.length,
  }
}

export function buildCachePaginatedResponse<
  TInput extends { fetched_at: number | null },
  TOutput,
>(
  items: TInput[],
  mapItem: (item: TInput) => TOutput,
  options: { offset: number; limit: number; ttlMs: number; source: string },
): PaginatedResult<TOutput> & { source: string; stale: boolean } {
  const { offset, limit, ttlMs, source } = options
  const anyStale = items.some((item) => isCacheStale(item.fetched_at, ttlMs))

  if (anyStale) {
    verbose('Cache is stale, consider using --fresh flag to refresh data')
  }

  const page = paginate(items, offset, limit)
  return { ...page, items: page.items.map(mapItem), source, stale: anyStale }
}
