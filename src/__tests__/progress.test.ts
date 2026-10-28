/**
 * Transfer progress: one rewritten stderr line for a TTY, nothing otherwise
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { setOutputFormat } from '../utils/output'
import { createProgress } from '../utils/progress'

function stream(isTTY: boolean) {
  const written: string[] = []
  return { isTTY, write: (text: string) => written.push(text), written }
}

afterEach(() => {
  setOutputFormat('json')
})

describe('createProgress', () => {
  it('is undefined off a TTY and in quiet mode', () => {
    expect(createProgress('a.bin', stream(false))).toBeUndefined()
    setOutputFormat('quiet')
    expect(createProgress('a.bin', stream(true))).toBeUndefined()
  })

  it('rewrites one line and ends it once done', () => {
    const out = stream(true)
    const progress = createProgress('report.pdf', out)!
    progress(1024 * 1024, 4 * 1024 * 1024)
    progress(4 * 1024 * 1024, 4 * 1024 * 1024)
    progress(4 * 1024 * 1024, 4 * 1024 * 1024)

    expect(out.written).toEqual([
      '\rreport.pdf 25% 1.0 MB / 4.0 MB\x1b[K',
      '\rreport.pdf 100% 4.0 MB / 4.0 MB\x1b[K',
      '\n',
    ])
  })

  it('shows only the bytes when the total is unknown', () => {
    const out = stream(true)
    createProgress('a.bin', out)!(2048, 0)
    expect(out.written).toEqual(['\ra.bin 2.0 KB\x1b[K'])
  })
})
