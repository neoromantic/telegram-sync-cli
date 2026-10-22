# Authentication

> **Status: ✅ Implemented**
>
> Authentication is implemented in `src/commands/auth.ts` using `@mtcute/bun`.

## Requirements

Set the API credentials in your environment (Bun auto-loads `.env`):

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

## Commands

### Phone Login

```bash
tg auth login --phone +15551234567
tg auth login --phone +15551234567 --label "Work"
```

Flow:
1. Create or reuse an account record in `data.db`.
2. Start mtcute auth flow (phone → code → optional 2FA password).
3. Persist session to `session_<id>.db`.
4. Update account metadata (user ID, display name, label).
5. Make the account the active one, so the next command uses it. A failed login leaves the
   active account as it was.

### QR Login

```bash
tg auth login-qr
tg auth login-qr --name "Personal"
```

Flow:
1. Generate a login QR code in the terminal.
2. Scan with Telegram mobile app: **Settings → Devices → Link Desktop Device**.
3. Persist session and update account metadata (including label when provided).
4. Make the account the active one, as the phone login does.

### Logout

```bash
tg auth logout
```

Logs out the active account (or a specific one via `--account` selector) and clears the local session.
Selectors accept **ID**, **@username**, or **label**.

### Status

```bash
tg auth status
```

Checks whether the active account session is valid and returns:
- account info
- authentication status
- a message if re-login is required

Use `--account` to target a specific account by **ID**, **@username**, or **label**.

## Storage

Authentication data lives in the data directory (default `~/.telegram-sync-cli`, override with `TELEGRAM_SYNC_CLI_DATA_DIR`):

- `data.db` — accounts table
- `session_<id>.db` — mtcute session storage per account
- `accounts/<id>/cache.db` — the account's cache and sync database (not required for login).
  `tg auth logout` keeps it; delete `accounts/<id>/` to drop it. Logging in again gives the
  account a new ID and an empty cache; to keep the old one, stop the daemon and rename
  `accounts/<old-id>/` to `accounts/<new-id>/` (see
  [configuration.md](configuration.md#storage-layout)).
- Before it changes the accounts, `tg auth login` (and `login-qr`, `logout`) moves a shared
  `cache.db` of 0.3 or older to the per-account layout. While an older tg still holds that
  file, or it can't be moved, they fail with `CACHE_UNAVAILABLE` (`shared_cache_in_use`,
  `move_failed`) and change no account until it moves, so the existing account keeps its cache
  and no account is handed rows that others wrote (see
  [configuration.md](configuration.md#upgrading-to-per-account-caches)).

## Notes

- If SMS codes are blocked for unofficial clients, use **QR login**.
- `auth login` will merge duplicate accounts if the same Telegram user is detected under another account ID.
