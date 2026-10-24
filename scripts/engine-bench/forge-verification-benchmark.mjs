import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "java-home": { type: "string", default: process.env.JAVA_HOME },
    jar: {
      type: "string",
      default: "forge-harness/target/forge-harness-jar-with-dependencies.jar",
    },
    "forge-home": { type: "string", default: "forge/forge-gui/" },
  },
});
const output = "tmp/journal-verification-classes";
const sources = "scripts/engine-bench/java/forge/harness/host";
mkdirSync(output, { recursive: true });
function run(command, args) {
  const binary = values["java-home"] ? join(values["java-home"], "bin", command) : command;
  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("javac", [
  "-cp",
  values.jar,
  "-d",
  output,
  ...readdirSync(sources)
    .filter((name) => name.endsWith(".java"))
    .map((name) => join(sources, name)),
]);
run("java", [
  "-Xms1g",
  "-Xmx1g",
  "-cp",
  [output, values.jar].join(delimiter),
  "forge.harness.host.VerificationBenchmark",
  values["forge-home"],
]);
