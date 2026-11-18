import { describe, expect, it } from "bun:test";
import {
  type Account,
  type AuthState,
  type Contact,
  type ErrorCode,
  ErrorCodes,
  type Output,
  type OutputFormat,
  type PaginatedResult,
} from "../types";

describe("Types Module", () => {
  describe("ErrorCodes", () => {
    it("should have GENERAL_ERROR", () => {
      expect(ErrorCodes.GENERAL_ERROR).toBe("GENERAL_ERROR");
    });

    it("should have AUTH_REQUIRED", () => {
      expect(ErrorCodes.AUTH_REQUIRED).toBe("AUTH_REQUIRED");
    });

    it("should have INVALID_ARGS", () => {
      expect(ErrorCodes.INVALID_ARGS).toBe("INVALID_ARGS");
    });

    it("should have NETWORK_ERROR", () => {
      expect(ErrorCodes.NETWORK_ERROR).toBe("NETWORK_ERROR");
    });

    it("should have TELEGRAM_ERROR", () => {
      expect(ErrorCodes.TELEGRAM_ERROR).toBe("TELEGRAM_ERROR");
    });

    it("should have ACCOUNT_NOT_FOUND", () => {
      expect(ErrorCodes.ACCOUNT_NOT_FOUND).toBe("ACCOUNT_NOT_FOUND");
    });

    it("should have NO_ACTIVE_ACCOUNT", () => {
      expect(ErrorCodes.NO_ACTIVE_ACCOUNT).toBe("NO_ACTIVE_ACCOUNT");
    });

    it("should have PHONE_CODE_INVALID", () => {
      expect(ErrorCodes.PHONE_CODE_INVALID).toBe("PHONE_CODE_INVALID");
    });

    it("should have SESSION_PASSWORD_NEEDED", () => {
      expect(ErrorCodes.SESSION_PASSWORD_NEEDED).toBe("SESSION_PASSWORD_NEEDED");
    });
  });

  describe("Type interfaces", () => {
    it("should allow Account type", () => {
      const account: Account = {
        id: 1,
        phone: "+1234567890",
        user_id: 12345,
        name: "Test",
        username: "testuser",
        label: "Work",
        session_data: "",
        is_active: 1,
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
      };

      expect(account.id).toBe(1);
    });

    it("should allow OutputFormat type", () => {
      const formats: OutputFormat[] = ["json", "pretty", "quiet"];
      expect(formats).toHaveLength(3);
    });

    it("should allow Contact type", () => {
      const contact: Contact = {
        id: 123,
        firstName: "John",
        lastName: "Doe",
        username: "johndoe",
        phone: "+1234567890",
      };

      expect(contact.username).toBe("johndoe");
    });

    it("should allow PaginatedResult type", () => {
      const result: PaginatedResult<Contact> = {
        items: [],
        total: 0,
        offset: 0,
        limit: 10,
        hasMore: false,
      };

      expect(result.hasMore).toBe(false);
    });

    it("should allow AuthState type - unauthorized", () => {
      const state: AuthState = { state: "unauthorized" };
      expect(state.state).toBe("unauthorized");
    });

    it("should allow AuthState type - awaiting_code", () => {
      const state: AuthState = {
        state: "awaiting_code",
        phone: "+1234567890",
        phoneCodeHash: "abc123",
      };
      expect(state.state).toBe("awaiting_code");
    });

    it("should allow AuthState type - awaiting_password", () => {
      const state: AuthState = {
        state: "awaiting_password",
        phone: "+1234567890",
        hint: "Your hint",
      };
      expect(state.state).toBe("awaiting_password");
    });

    it("should allow AuthState type - authorized", () => {
      const state: AuthState = {
        state: "authorized",
        user: { id: 123, firstName: "Test" },
      };
      expect(state.state).toBe("authorized");
    });

    it("should allow Output type - success", () => {
      const output: Output<{ message: string }> = {
        success: true,
        data: { message: "ok" },
      };

      expect(output.success).toBe(true);
    });

    it("should allow ErrorCode type", () => {
      const code: ErrorCode = "AUTH_REQUIRED";
      expect(code).toBe("AUTH_REQUIRED");
    });
  });
});
