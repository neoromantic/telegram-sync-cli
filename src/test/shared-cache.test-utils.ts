import { Database } from "bun:sqlite";

/** Rows of the tables that make a shared cache worth keeping */
export function rowCounts(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const count = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      messages_cache: count("messages_cache"),
      chats_cache: count("chats_cache"),
      users_cache: count("users_cache"),
    };
  } finally {
    db.close();
  }
}

/** An older tg: keeps a file open, idle, until released */
export function holdOpen(path: string) {
  const holder = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "-e",
      `
        import { Database } from 'bun:sqlite'
        const db = new Database(process.env.HOLD_PATH)
        db.query('SELECT COUNT(*) FROM chats_cache').get()
        console.log('open')
        for await (const _ of console) break
        db.close()
      `,
    ],
    {
      env: { ...process.env, HOLD_PATH: path },
      stdin: "pipe",
      stdout: "pipe",
    },
  );
  return {
    pid: holder.pid,
    async ready() {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of holder.stdout) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes("open")) return;
      }
      throw new Error("holder exited before it opened the file");
    },
    async release() {
      holder.stdin.write("done\n");
      holder.stdin.end();
      await holder.exited;
    },
  };
}
