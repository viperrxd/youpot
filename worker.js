// Worker script — runs in a separate process to isolate jsdom memory usage
const { generate } = require("youtube-po-token-generator");

generate()
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(err.message || "Unknown error");
    process.exit(1);
  });
