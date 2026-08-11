#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
await jiti.import("../extensions/pi-herdr-orchestrator.ts");
await jiti.import("../extensions/role-guard.ts");
process.stdout.write("Extension imports passed.\n");
