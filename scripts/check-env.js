#!/usr/bin/env node
// Fails fast with an actionable message when the local environment isn't
// ready, instead of letting the test suite die with a connection error
// that doesn't say what to fix.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const problems = [];
const notes = [];

const major = Number(process.versions.node.split(".")[0]);
if (major < 18) problems.push(`Node ${process.versions.node} found; this project needs Node 18+.`);

const envPath = path.join(__dirname, "..", "backend", ".env");
if (!fs.existsSync(envPath)) {
  const example = path.join(__dirname, "..", "backend", ".env.example");
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    notes.push("Created backend/.env from .env.example - fill in real keys before using Stripe or AI features.");
  } else {
    problems.push("backend/.env is missing and there's no .env.example to copy.");
  }
}

try {
  execSync("pg_isready", { stdio: "ignore" });
} catch {
  problems.push(
    "PostgreSQL doesn't appear to be running.\n" +
    "    Linux:  sudo service postgresql start\n" +
    "    macOS:  brew services start postgresql@16\n" +
    "    Docker: docker compose up -d db"
  );
}

for (const note of notes) console.log(`note: ${note}`);

if (problems.length > 0) {
  console.error("\nSetup is incomplete:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix the above, then re-run: npm run setup\n");
  process.exit(1);
}

console.log("\nEnvironment looks good. Next:\n  npm run migrate   # create the schema\n  npm test          # run the suite\n");
