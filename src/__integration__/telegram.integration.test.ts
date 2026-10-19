import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCliSuccess } from '../__e2e__/helpers/cli'
import {
  createIntegrationEnvironment,
  type IntegrationEnvironment,
} from './helpers/setup'

const TEST_ACCOUNT = process.env.TELEGRAM_TEST_ACCOUNT
const TEST_SESSION_PATH =
  process.env.TELEGRAM_TEST_SESSION_PATH ?? process.env.TELEGRAM_TEST_SESSION
// test-setup.ts replaces TELEGRAM_API_* with dummies and stashes the real
// values under TELEGRAM_TEST_API_*
const API_ID = process.env.TELEGRAM_TEST_API_ID
const API_HASH = process.env.TELEGRAM_TEST_API_HASH
const SHOULD_RUN = Boolean(
  TEST_ACCOUNT && TEST_SESSION_PATH && API_ID && API_HASH,
)

describe.skipIf(!SHOULD_RUN)(
  'Integration: Telegram Sync CLI (real API)',
  () => {
    let env: IntegrationEnvironment

    beforeEach(async () => {
      env = createIntegrationEnvironment('telegram')
      await env.initFromSession({
        phone: TEST_ACCOUNT!,
        sessionPath: TEST_SESSION_PATH!,
      })
    })

    afterEach(() => {
      env.cleanup()
    })

    function buildCliOptions() {
      return {
        ...env.getCliOptions({
          TELEGRAM_API_ID: API_ID!,
          TELEGRAM_API_HASH: API_HASH!,
        }),
        timeout: 30000,
      }
    }

    it('auth status confirms authentication', async () => {
      const result = await runCliSuccess(['auth', 'status'], buildCliOptions())
      const payload = result.json as {
        success: boolean
        data: { authenticated: boolean; account?: { phone: string } }
      }

      expect(payload.success).toBe(true)
      expect(payload.data.authenticated).toBe(true)
      expect(payload.data.account?.phone).toBe(TEST_ACCOUNT)
    })

    it('user me fetches current profile', async () => {
      const result = await runCliSuccess(
        ['user', 'me', '--fresh'],
        buildCliOptions(),
      )
      const payload = result.json as {
        success: boolean
        data: { user: { id: number; username?: string | null } }
      }

      expect(payload.success).toBe(true)
      expect(typeof payload.data.user.id).toBe('number')
    })

    it('contacts list fetches contacts from API', async () => {
      const result = await runCliSuccess(
        ['contacts', 'list', '--fresh', '--limit', '1'],
        buildCliOptions(),
      )
      const payload = result.json as {
        success: boolean
        data: { items: unknown[]; total: number }
      }

      expect(payload.success).toBe(true)
      expect(Array.isArray(payload.data.items)).toBe(true)
      expect(typeof payload.data.total).toBe('number')
    })

    it('chats list fetches dialogs from API', async () => {
      const result = await runCliSuccess(
        ['chats', 'list', '--fresh', '--limit', '1'],
        buildCliOptions(),
      )
      const payload = result.json as {
        success: boolean
        data: { items: unknown[]; total: number }
      }

      expect(payload.success).toBe(true)
      expect(Array.isArray(payload.data.items)).toBe(true)
      expect(typeof payload.data.total).toBe('number')
    })

    it('send delivers a message to the test recipient', async () => {
      const meResult = await runCliSuccess(
        ['user', 'me', '--fresh'],
        buildCliOptions(),
      )
      const mePayload = meResult.json as {
        success: boolean
        data: { user: { username?: string | null } }
      }

      const fallbackRecipient = mePayload.data.user.username
        ? `@${mePayload.data.user.username}`
        : TEST_ACCOUNT!
      const recipient = process.env.TELEGRAM_TEST_RECIPIENT ?? fallbackRecipient

      const message = `tgcli integration test ${new Date().toISOString()}`

      const result = await runCliSuccess(
        ['send', '--to', recipient, '--message', message, '--silent'],
        buildCliOptions(),
      )
      const payload = result.json as {
        success: boolean
        data: { sent: boolean; messageId: number | null }
      }

      expect(payload.success).toBe(true)
      expect(payload.data.sent).toBe(true)
    })
  },
)
