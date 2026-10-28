/**
 * Output utilities tests
 */

import type { Mock } from 'bun:test'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { type ErrorCode, ErrorCodes } from '../types'
import {
  error,
  getExitCode,
  getOutputFormat,
  info,
  setOutputFormat,
  success,
  verbose,
} from '../utils/output'

// Set test environment to prevent process.exit
process.env.BUN_ENV = 'test'

describe('Output Utilities', () => {
  let logSpy: Mock<typeof console.log>
  let errorSpy: Mock<typeof console.error>

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    setOutputFormat('json')
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    setOutputFormat('json')
    delete process.env.VERBOSE
  })

  describe('setOutputFormat / getOutputFormat', () => {
    it('should set format to pretty', () => {
      setOutputFormat('pretty')
      expect(getOutputFormat()).toBe('pretty')
    })

    it('should set format to quiet', () => {
      setOutputFormat('quiet')
      expect(getOutputFormat()).toBe('quiet')
    })
  })

  describe('success', () => {
    it('should output JSON with success wrapper in json mode', () => {
      setOutputFormat('json')
      success({ message: 'test' })

      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(output.success).toBe(true)
      expect(output.data).toEqual({ message: 'test' })
    })

    it('should output data only in pretty mode', () => {
      setOutputFormat('pretty')
      success({ message: 'test' })

      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(output.success).toBeUndefined()
      expect(output.message).toBe('test')
    })

    it('should output nothing in quiet mode', () => {
      setOutputFormat('quiet')
      success({ message: 'test' })

      expect(logSpy).not.toHaveBeenCalled()
    })

    it('should handle complex data', () => {
      success({
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        total: 2,
      })

      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(output.data.users).toHaveLength(2)
      expect(output.data.total).toBe(2)
    })

    it('should handle null data', () => {
      success(null)

      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(output.data).toBeNull()
    })

    it('should handle array data', () => {
      success([1, 2, 3])

      const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(output.data).toEqual([1, 2, 3])
    })
  })

  describe('error', () => {
    it('should output error JSON and throw in test mode', () => {
      setOutputFormat('json')

      expect(() =>
        error(ErrorCodes.GENERAL_ERROR, 'Something went wrong'),
      ).toThrow('Something went wrong')
      expect(errorSpy).toHaveBeenCalledTimes(1)

      const output = JSON.parse(errorSpy.mock.calls[0]?.[0] as string)
      expect(output.success).toBe(false)
      expect(output.error.code).toBe('GENERAL_ERROR')
      expect(output.error.message).toBe('Something went wrong')
    })

    it('should include details in error', () => {
      try {
        error(ErrorCodes.TELEGRAM_ERROR, 'API error', {
          endpoint: '/test',
          status: 500,
        })
      } catch (_e) {
        // Expected
      }

      const output = JSON.parse(errorSpy.mock.calls[0]?.[0] as string)
      expect(output.error.details).toEqual({ endpoint: '/test', status: 500 })
    })

    it('should not output in quiet mode but still throw', () => {
      setOutputFormat('quiet')

      expect(() => error(ErrorCodes.GENERAL_ERROR, 'Test')).toThrow()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('should set code and details on thrown error', () => {
      try {
        error(ErrorCodes.AUTH_REQUIRED, 'Not logged in', { account: 1 })
      } catch (e: unknown) {
        const err = e as { code?: string; details?: Record<string, unknown> }
        expect(err.code).toBe('AUTH_REQUIRED')
        expect(err.details).toEqual({ account: 1 })
      }
    })
  })

  describe('getExitCode', () => {
    it('should return 2 for AUTH_REQUIRED', () => {
      expect(getExitCode(ErrorCodes.AUTH_REQUIRED)).toBe(2)
    })

    it('should return 3 for INVALID_ARGS', () => {
      expect(getExitCode(ErrorCodes.INVALID_ARGS)).toBe(3)
    })

    it('should return 4 for NETWORK_ERROR', () => {
      expect(getExitCode(ErrorCodes.NETWORK_ERROR)).toBe(4)
    })

    it('should return 5 for TELEGRAM_ERROR', () => {
      expect(getExitCode(ErrorCodes.TELEGRAM_ERROR)).toBe(5)
    })

    it('should return 6 for ACCOUNT_NOT_FOUND', () => {
      expect(getExitCode(ErrorCodes.ACCOUNT_NOT_FOUND)).toBe(6)
    })

    it('should return 1 for GENERAL_ERROR', () => {
      expect(getExitCode(ErrorCodes.GENERAL_ERROR)).toBe(1)
    })

    it('should return 1 for the media error codes', () => {
      for (const code of [
        ErrorCodes.NO_MEDIA,
        ErrorCodes.MESSAGE_NOT_FOUND,
        ErrorCodes.CONTENT_PROTECTED,
        ErrorCodes.MEDIA_UNSUPPORTED,
        ErrorCodes.FILE_EXISTS,
      ]) {
        expect(getExitCode(code)).toBe(1)
      }
    })

    it('should return 1 for unknown error codes', () => {
      expect(getExitCode('UNKNOWN_ERROR' as ErrorCode)).toBe(1)
    })
  })

  describe('info', () => {
    it('should output to stderr in json mode', () => {
      setOutputFormat('json')
      info('Info message')

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toBe('Info message')
    })

    it('should output to stderr in pretty mode', () => {
      setOutputFormat('pretty')
      info('Info message')

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toBe('Info message')
    })

    it('should not output in quiet mode', () => {
      setOutputFormat('quiet')
      info('Info message')

      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('verbose', () => {
    it('should not output when VERBOSE is not set', () => {
      delete process.env.VERBOSE
      verbose('Verbose message')

      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('should output with prefix when VERBOSE=1', () => {
      process.env.VERBOSE = '1'
      verbose('Verbose message')

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toBe('[verbose] Verbose message')
    })

    it('should not output when VERBOSE is other value', () => {
      process.env.VERBOSE = '0'
      verbose('Verbose message')

      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('snapshots', () => {
    it('should match json success output', () => {
      setOutputFormat('json')
      success({
        message: 'Snapshot test',
        count: 2,
        items: ['alpha', 'beta'],
      })

      expect(logSpy.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
"{
  "success": true,
  "data": {
    "message": "Snapshot test",
    "count": 2,
    "items": [
      "alpha",
      "beta"
    ]
  }
}"
`)
    })
  })
})
