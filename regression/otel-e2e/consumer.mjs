// e2e 샘플 consumer: `jt-e2e` 큐 메시지를 받아 일부러 실패한다.
// 이 프로세스의 root 스팬은 amqplib 계측의 consume 스팬 — 로컬 active context 없이
// 원격 부모(traceparent)만 가진 채로 시작하고 끝나는 케이스다.
import "@jaytrace/node/init";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const amqp = require("amqplib");

const queue = process.env.JT_E2E_QUEUE ?? "jt-e2e";
const amqpUrl = process.env.JT_E2E_AMQP_URL ?? "amqp://127.0.0.1:5673";

const connection = await amqp.connect(amqpUrl);
const channel = await connection.createChannel();
await channel.assertQueue(queue, { durable: false });

await channel.consume(queue, (msg) => {
  if (!msg) {
    return;
  }
  try {
    console.error("consumer failing on purpose");
    throw new Error("consumer failing on purpose");
  } catch {
    // nack 이 consume 스팬을 ERROR 로 끝낸다. process 는 살려둔다.
    channel.nack(msg, false, false);
  }
});

console.log("consumer ready");
