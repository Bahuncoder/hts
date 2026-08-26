import http from "node:http";
import fs from "node:fs";
const out = "/tmp/mailbox.jsonl";
fs.writeFileSync(out, "");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(out, body + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "captured" }));
  });
}).listen(4444, () => console.log("mailcatch on :4444"));
