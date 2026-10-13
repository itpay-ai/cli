import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageResourcePath(...segments: string[]): string {
  const modulePath=fileURLToPath(import.meta.url);
  // The source module lives in src/state; the only published runtime in dist/src.
  const root=resolve(dirname(modulePath),"..","..");
  if (!basename(modulePath).startsWith("package_resources.") && basename(modulePath)!=="main.js") throw new Error("unsupported CLI resource layout");
  const metadata=resolve(root,"package.json");
  if(!existsSync(metadata) || JSON.parse(readFileSync(metadata,"utf8")).name!=="@itpay/cli")throw new Error("current CLI package resources are unavailable");
  return resolve(root,...segments);
}
