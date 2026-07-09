import { spawn } from "node:child_process";

const confirmed = process.argv.includes("--yes");

if (!confirmed) {
  console.error("QA reset is destructive: it deletes the local QA Postgres and upload volumes.");
  console.error("Run `npm run qa:reset:danger -- --yes` if that is what you intend.");
  process.exit(1);
}

const child = spawn("docker", ["compose", "-f", "docker-compose.qa.yml", "down", "-v"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", code => {
  process.exit(code ?? 1);
});
