import { Module } from "@nestjs/common";
import { JayTraceModule, resolveJayTraceEnvOptions } from "@jaytrace/nestjs";
import { createJayTraceDbIndexer } from "./jaytrace-db-indexer.js";
import { PaymentsController } from "./payments.controller.js";
import { RetentionController } from "./retention.controller.js";

const dbIndexer = createJayTraceDbIndexer();

@Module({
  imports: [
    JayTraceModule.forRoot({
      ...resolveJayTraceEnvOptions(),
      ...(dbIndexer
        ? { onExported: (info) => dbIndexer.indexDocument(info) }
        : {})
    })
  ],
  controllers: [PaymentsController, RetentionController]
})
export class AppModule {}
