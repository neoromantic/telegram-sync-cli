#!/usr/bin/env bun
/**
 * Telegram Sync CLI - Main Entry Point
 *
 * A comprehensive Telegram Sync CLI client for agent-friendly automation.
 */
import { runMain } from "citty";
import { main } from "./cli";
import { guardCommands } from "./commands/access";
import { instrumentCommands } from "./telemetry";
import { EVENTS_ENV } from "./telemetry/background";
import { sendHandoff } from "./telemetry/send";

// The compiled binary is also the copy of tg that sends a run's usage stats
if (process.env[EVENTS_ENV] !== undefined) {
  void sendHandoff(process.env[EVENTS_ENV]);
} else {
  guardCommands(main);
  instrumentCommands(main);
  runMain(main);
}
