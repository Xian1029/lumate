#!/usr/bin/env node
/*
 * Start one local service in its own session and report its real PID.
 *
 * Shell `nohup cmd &` is not sufficient in every terminal supervisor: a
 * wrapper may still reap the command when the launching script exits.  Node's
 * detached spawn calls setsid on POSIX, so start.sh can reliably return while
 * stop.sh later terminates the fixed listener.
 */
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [logPath, cwd, command, ...args] = process.argv.slice(2);
if (!logPath || !cwd || !command) {
  console.error("Usage: detached-process.cjs <log-path> <cwd> <command> [args...]");
  process.exit(2);
}

const logFd = fs.openSync(logPath, "a");
const child = spawn(command, args, {
  cwd,
  detached: true,
  env: process.env,
  stdio: ["ignore", logFd, logFd],
});
child.unref();
console.log(child.pid);
