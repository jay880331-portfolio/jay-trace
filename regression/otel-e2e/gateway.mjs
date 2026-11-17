// e2e 샘플 gateway: HTTP `/boom` -> RabbitMQ publish -> 500 응답.
// `@jaytrace/node/init` 이 amqplib/http 보다 먼저 로드돼야 계측이 붙는다.
import "@jaytrace/node/init";
import { createRequire } from "node:module";

// ESM 의 `import`는 CJS 로더를 우회할 수 있어 require-in-the-middle 훅이 안 걸리는 경우가 있다.
// 계측 대상 모듈은 require 로 받는다.
const require = createRequire(import.meta.url);
const http = require("http");
const amqp = require("amqplib");

const queue = process.env.JT_E2E_QUEUE ?? "jt-e2e";
const amqpUrl = process.env.JT_E2E_AMQP_URL ?? "amqp://127.0.0.1:5673";

const connection = await amqp.connect(amqpUrl);
const channel = await connection.createChannel();
await channel.assertQueue(queue, { durable: false });

// 활성 스팬이 전혀 없는 상태에서 나가는 요청 — http 계측의 CLIENT 스팬이 그 자체로 root 가 된다.
// S3 exporter 가 자기 PUT 을 계측하면 이 root 가 문서 -> PUT -> 새 root 로 무한 증폭한다.
if (process.env.JT_E2E_PING_URL) {
  await new Promise((resolve) => {
    http
      .get(process.env.JT_E2E_PING_URL, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", resolve);
  });
}

// 수동 스팬 없음: 이 요청의 root 는 http 계측이 만드는 SERVER 스팬 하나뿐이다.
const server = http.createServer((req, res) => {
  if (req.url !== "/boom") {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  channel.sendToQueue(queue, Buffer.from(JSON.stringify({ at: Date.now() })));
  console.error("gateway published to jt-e2e then failed");
  res.writeHead(500, { "content-type": "text/plain" }).end("boom");
});

server.listen(0, "127.0.0.1", () => {
  console.log(`gateway listening ${server.address().port}`);
});
