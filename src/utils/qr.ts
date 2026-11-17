/**
 * QR codes for the terminal
 */

import { encode } from 'uqr'

/** The quiet zone the QR code standard asks for, in modules */
const QUIET_ZONE = 4

/** Black text on a white background, so the code reads the same in dark and light themes */
const COLORS = '\x1b[30;47m'
const RESET = '\x1b[0m'

/**
 * Render text as a QR code of half blocks: each character holds two rows of
 * modules (the upper one in the text colour when `▀`, the lower one when `▄`).
 */
export function renderQr(text: string): string {
  const { data } = encode(text, { border: QUIET_ZONE })
  const dark = (row: number, col: number) => data[row]?.[col] === true
  const lines: string[] = []
  for (let row = 0; row < data.length; row += 2) {
    let line = ''
    for (let col = 0; col < data.length; col++) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(`${COLORS}${line}${RESET}`)
  }
  return lines.join('\n')
}
