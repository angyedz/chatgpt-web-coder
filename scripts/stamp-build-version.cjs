"use strict";

const fs = require("node:fs");
const path = require("node:path");

const version = process.argv[2] || "";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+build\.\d+\.\d+$/.test(version)) {
  throw new Error("Expected a unique SemVer CI version: <base>+build.<run>.<attempt>.");
}

const root = process.cwd();
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
if (pkg.name !== "chatgpt-coder" || lock.name !== pkg.name ||
    lock.packages?.[""]?.name !== pkg.name ||
    pkg.version !== lock.version || pkg.version !== lock.packages[""].version) {
  throw new Error("Source package and lockfile must agree before stamping a build.");
}
const base = version.split("+", 1)[0];
if (pkg.version.split("+", 1)[0] !== base) {
  throw new Error("CI version must preserve the source package's base version.");
}
pkg.version = version;
lock.version = version;
lock.packages[""].version = version;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
process.stdout.write("Packaged version: " + version + "\n");
