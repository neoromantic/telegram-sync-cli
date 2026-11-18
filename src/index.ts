#!/usr/bin/env bun
import { runMain } from "citty";
import { main } from "./cli";
import { guardCommands } from "./commands/access";
import { instrumentCommands } from "./telemetry";
import { EVENTS_ENV } from "./telemetry/background";
import { sendHandoff } from "./telemetry/send";

if (process.env[EVENTS_ENV] !== undefined) {
  void sendHandoff(process.env[EVENTS_ENV]);
} else {
  guardCommands(main);
  instrumentCommands(main);
  runMain(main);
}
