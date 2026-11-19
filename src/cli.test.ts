import { expect, it } from "bun:test";

it("loads mtcute only once a command calls Telegram, so a cache read starts fast", async () => {
  await import("./cli");

  expect(Object.keys(require.cache).filter((path) => path.includes("/@mtcute/"))).toEqual([]);
});
