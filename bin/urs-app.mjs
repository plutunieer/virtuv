#!/usr/bin/env node
// Startet die URS-App (Web-Oberfläche auf http://127.0.0.1:8812).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const hier = dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [join(hier, "..", "src", "server.ts")], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
